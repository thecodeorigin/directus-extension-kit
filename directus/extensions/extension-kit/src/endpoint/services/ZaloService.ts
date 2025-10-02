import type { SchemaOverview } from '@directus/types'
import type { Knex } from 'knex'
import fs from 'node:fs'
import path from 'node:path'
import { match, P } from 'ts-pattern'
import { LoginQRCallbackEventType, Zalo } from 'zca-js'

interface ZaloSession {
  userId: string
  loginTime: string
  isActive: boolean
}

export class ZaloService {
  private static instance: ZaloService | null = null

  private zalo: Zalo
  private api: any = null
  private db: Knex
  private getSchemaFn: () => Promise<SchemaOverview>
  private ItemsService: any

  private status: 'logged_out' | 'pending_qr' | 'logged_in' = 'logged_out'
  private qrCode: string | null = null
  private loginResolver: ((value: any) => void) | null = null
  private listenerStarted = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 5000

  private sessionFile: string

  // System accountability (use system admin by default)
  private systemAccountability = {
    admin: true,
    role: null,
    user: null,
  }

  private constructor(db: Knex, getSchemaFn: () => Promise<SchemaOverview>, ItemsService: any) {
    this.db = db
    this.getSchemaFn = getSchemaFn
    this.ItemsService = ItemsService

    const zaloDataPath = process.env.ZALO_SESSION_PATH || '/directus/storage'
    this.sessionFile = path.join(zaloDataPath, 'zalo-session.json')

    this.zalo = new Zalo({
      selfListen: true,
      checkUpdate: false,
    })

    console.log('[ZaloService] Initialized')
    console.log(`[ZaloService] Session file: ${this.sessionFile}`)

    this.loadOldSession()
  }

  public static init(
    db: Knex,
    getSchemaFn: () => Promise<SchemaOverview>,
    ItemsService: any,
  ) {
    if (!ZaloService.instance) {
      ZaloService.instance = new ZaloService(db, getSchemaFn, ItemsService)
    }
    return ZaloService.instance
  }

  public static getInstance(): ZaloService {
    if (!ZaloService.instance) {
      throw new Error('ZaloService has not been initialized yet')
    }
    return ZaloService.instance
  }

  /** Load session cũ */
  private loadOldSession(): void {
    try {
      if (!fs.existsSync(this.sessionFile)) {
        console.log('[ZaloService] No session file found')
        return
      }

      const data = fs.readFileSync(this.sessionFile, 'utf-8')
      const session: ZaloSession = JSON.parse(data)

      const age = Date.now() - new Date(session.loginTime).getTime()
      if (age > 24 * 60 * 60 * 1000) {
        console.log('[ZaloService] Session expired')
        fs.unlinkSync(this.sessionFile)
        return
      }

      console.log(`[ZaloService] Found session: ${session.userId}`)
      console.log('[ZaloService] Need to re-login with QR')
    }
    catch (err) {
      console.error('[ZaloService] Load session error:', err)
    }
  }

  /** Save session */
  private saveSessionToFile(userId: string): void {
    try {
      const dir = path.dirname(this.sessionFile)
      if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true })

      const session: ZaloSession = {
        userId,
        loginTime: new Date().toISOString(),
        isActive: true,
      }

      fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2), 'utf-8')
      console.log(`[ZaloService] Session saved: ${userId}`)
    }
    catch (err) {
      console.error('[ZaloService] Save session error:', err)
    }
  }

  public getStatus() {
    return {
      status: this.status,
      qrCode: this.qrCode,
      isListening: this.listenerStarted,
      userId: this.api?.getOwnId() || null,
    }
  }

  /** Login bằng QR */
  public async initiateLogin(): Promise<any> {
    if (this.status !== 'logged_out')
      return this.getStatus()

    this.status = 'pending_qr'
    console.log('[ZaloService] Starting QR login...')

    return new Promise<any>((resolve, reject) => {
      this.loginResolver = resolve

      const timeout = setTimeout(() => {
        reject(new Error('Login timeout'))
        this.reset()
      }, 120000)

      this.zalo
        .loginQR({}, async (response) => {
          match(response)
            .with(
              { type: LoginQRCallbackEventType.QRCodeGenerated, data: { image: P.select(P.string) } },
              (qrImage) => {
                this.qrCode = qrImage
                console.log('[ZaloService] QR code generated')
                if (this.loginResolver)
                  this.loginResolver(this.getStatus())
              },
            )
            .with({ type: LoginQRCallbackEventType.QRCodeExpired }, () => {
              clearTimeout(timeout)
              this.reset()
            })
            .with({ type: LoginQRCallbackEventType.QRCodeDeclined }, () => {
              clearTimeout(timeout)
              this.reset()
            })
            .otherwise(() => {
              console.log('[ZaloService] Login event:', response.type)
            })
        })
        .then((api) => {
          clearTimeout(timeout)
          this.api = api
          this.status = 'logged_in'
          this.qrCode = null

          const userId = this.api?.getOwnId?.() || 'unknown'
          console.log(`[ZaloService] Logged in as: ${userId}`)
          this.saveSessionToFile(userId)

          this.startListener()
          if (this.loginResolver)
            this.loginResolver(this.getStatus())
        })
        .catch((err) => {
          clearTimeout(timeout)
          console.error('[ZaloService] Login failed:', err)
          this.reset()
          reject(err)
        })
    })
  }

  private startListener() {
    if (!this.api || this.listenerStarted)
      return
    this.listenerStarted = true

    try {
      this.api.listener
        .on('message', async (msg: any) => {
          try {
            await this.handleIncomingMessage(msg.data)
          }
          catch (err) {
            console.error('[ZaloService] Error handling message:', err)
          }
        })
        .on('reaction', async (react: any) => {
          try {
            await this.handleIncomingReaction(react.data)
          }
          catch (err) {
            console.error('[ZaloService] Error handling reaction:', err)
          }
        })
        .on('error', async (err: any) => {
          console.error('[ZaloService] Listener error:', err)
          this.handleListenerError()
        })
        .start()
      this.reconnectAttempts = 0
    }
    catch (err) {
      this.listenerStarted = false
      console.error('[ZaloService] startListener error:', err)
      this.handleListenerError()
    }
  }

  /**
   * Xử lý tin nhắn đến - tạo/ cập nhật các items
   *  Hỗ trợ cả 2 dạng payload: direct raw fields (msgId, uidFrom...)
   *  hoặc wrapped under rawData.message.*
   */
  private async handleIncomingMessage(rawData: any) {
    try {
      const schema = await this.getSchemaFn()

      // Normalize possible shapes
      const messageRoot = rawData.message ?? rawData
      const messageId = messageRoot.msgId ?? messageRoot.msg_id ?? messageRoot.id ?? messageRoot.messageId
      const senderId = messageRoot.uidFrom ?? messageRoot.senderId ?? messageRoot.sender?.id ?? messageRoot.uid_from
      const recipientId = messageRoot.idTo ?? messageRoot.recipientId ?? messageRoot.recipient?.id ?? messageRoot.id_to
      const displayName = messageRoot.dName ?? messageRoot.sender?.dName ?? messageRoot.sender?.name ?? messageRoot.d_name
      const content = messageRoot.content ?? messageRoot.text ?? messageRoot.body ?? ''
      const timestamp = messageRoot.ts ? Number.parseInt(String(messageRoot.ts)) : (messageRoot.timestamp ? Number.parseInt(String(messageRoot.timestamp)) : Date.now())
      const clientMsgId = messageRoot.cliMsgId ?? messageRoot.client_id ?? null
      const attachments = messageRoot.attachments ?? messageRoot.attach ?? messageRoot.files ?? null

      // Basic validation
      if (!messageId || !senderId) {
        console.error('[ZaloService] Missing required message fields:', { messageId, senderId })
        return
      }

      // Create conversationId deterministically
      const userIds = [String(senderId), String(recipientId)].filter(Boolean).sort()
      const conversationId = userIds.length === 2 ? `direct_${userIds[0]}_${userIds[1]}` : `direct_${String(senderId)}`

      console.log('[ZaloService] Processing message:', { messageId, conversationId, senderId, displayName })

      // Prepare services
      const usersService = new this.ItemsService('zalo_users', {
        knex: this.db,
        schema,
        accountability: this.systemAccountability,
      })
      const conversationsService = new this.ItemsService('zalo_conversations', {
        knex: this.db,
        schema,
        accountability: this.systemAccountability,
      })
      const messagesService = new this.ItemsService('zalo_messages', {
        knex: this.db,
        schema,
        accountability: this.systemAccountability,
      })

      // 1) Upsert sender
      const userData = {
        id: String(senderId),
        display_name: displayName || String(senderId),
        avatar_url: (messageRoot.avatar || messageRoot.sender?.avatar) ?? null,
        phone: null,
        status: 'active',
        updated_at: new Date(),
      }
      await this.upsertItem(usersService, String(senderId), userData)

      // 2) Upsert recipient if different
      if (recipientId && String(recipientId) !== String(senderId)) {
        const recData = {
          id: String(recipientId),
          display_name: 'Unknown',
          updated_at: new Date(),
        }
        await this.upsertItem(usersService, String(recipientId), recData)
      }

      // 3) Upsert conversation
      const conversationData = {
        id: conversationId,
        type: 'direct',
        participant_id: recipientId ? String(recipientId) : null,
        group_id: null,
        is_pinned: false,
        is_muted: false,
        is_archived: false,
        is_hidden: false,
        unread_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }
      await this.upsertItem(conversationsService, conversationId, conversationData)

      // 4) Upsert message
      const messageData: any = {
        id: String(messageId),
        client_id: clientMsgId || String(messageId),
        conversation_id: conversationId,
        sender_id: String(senderId),
        content,
        raw_data: JSON.stringify(rawData),
        mentions: null,
        forward_from_message_id: null,
        reply_to_message_id: null,
        is_edited: false,
        is_undone: false,
        created_at: new Date(),
        sent_at: new Date(timestamp),
        received_at: new Date(),
        edited_at: null,
        updated_at: new Date(),
      }

      await this.upsertItem(messagesService, String(messageId), messageData)

      // 5) Attachments (if any)
      if (attachments && Array.isArray(attachments) && attachments.length > 0) {
        await this.createAttachments(String(messageId), attachments, schema)
      }

      // 6) Update conversation last message
      await this.updateConversationLastMessage(conversationId, String(messageId), new Date(timestamp), schema)
    }
    catch (error) {
      console.error('[ZaloService] Error handling message:', error)
    }
  }

  /** Upsert helper: nếu tồn tại -> updateOne, ngược lại -> createOne */
  private async upsertItem(service: any, id: string, data: any) {
    try {
      const existing = await service.readByQuery({
        filter: { id: { _eq: id } },
        limit: 1,
      })

      if (!existing || existing.length === 0) {
        await service.createOne(data)
        console.log(`[ZaloService][Upsert] Created item id=${id}`)
      }
      else {
        try {
          await service.updateOne(id, data)
          console.log(`[ZaloService][Upsert] Updated item id=${id}`)
        }
        catch {
          await service.updateByQuery({ filter: { id: { _eq: id } } }, data)
          console.log(`[ZaloService][Upsert] UpdatedByQuery item id=${id}`)
        }
      }
    }
    catch (err) {
      console.error(`[ZaloService][Upsert] Error upserting id=${id}:`, err)
    }
  }

  /** Tạo attachments */
  private async createAttachments(messageId: string, attachments: any[], schema: SchemaOverview) {
    try {
      const attachmentsService = new this.ItemsService('zalo_attachments', {
        knex: this.db,
        schema,
        accountability: this.systemAccountability,
      })

      for (const att of attachments) {
        // normalize fields
        const payload = {
          message_id: messageId,
          type: att.type ?? att.mediaType ?? 'file',
          url: att.url ?? att.fileUrl ?? '',
          file_name: att.fileName ?? att.name ?? null,
          file_size: att.fileSize ?? att.size ?? null,
          mime_type: att.mimeType ?? att.type ?? null,
          thumbnail_url: att.thumbnailUrl ?? att.thumb ?? null,
          width: att.width ?? null,
          height: att.height ?? null,
          duration: att.duration ?? null,
          metadata: att.metadata ? JSON.stringify(att.metadata) : null,
          created_at: new Date(),
          updated_at: new Date(),
        }

        await attachmentsService.createOne(payload)
      }
      console.log(`[ZaloService] Created ${attachments.length} attachments for message:`, messageId)
    }
    catch (error) {
      console.error('[ZaloService] Error creating attachments:', error)
    }
  }

  /** Update conversation's last message */
  private async updateConversationLastMessage(
    conversationId: string,
    messageId: string,
    messageTime: Date,
    schema: SchemaOverview,
  ) {
    try {
      const conversationsService = new this.ItemsService('zalo_conversations', {
        knex: this.db,
        schema,
        accountability: this.systemAccountability,
      })

      await conversationsService.updateByQuery(
        { filter: { id: { _eq: conversationId } } },
        {
          last_message_id: messageId,
          last_message_time: messageTime,
          updated_at: new Date(),
        },
      )
    }
    catch (error) {
      console.error('[ZaloService] Error updating conversation last message:', error)
    }
  }

  /** Xử lý reaction */
  private async handleIncomingReaction(rawData: any) {
    try {
      const schema = await this.getSchemaFn()
      const reactionsService = new this.ItemsService('zalo_reactions', {
        knex: this.db,
        schema,
        accountability: this.systemAccountability,
      })

      const messageId = rawData.msgId
      const userId = rawData.uidFrom
      const reactionIcon = rawData.content?.rIcon || null

      if (!messageId || !userId || !reactionIcon) {
        console.warn('[ZaloService] Reaction missing fields, skip:', {
          messageId,
          userId,
          reactionIcon,
        })
        return
      }

      const payload = {
        message_id: messageId,
        user_id: userId,
        reaction_icon: reactionIcon,
        created_at: new Date(),
      }

      console.log('[ZaloService] Saving reaction:', payload)
      await reactionsService.createOne(payload)
    }
    catch (err) {
      console.error('[ZaloService] Error saving reaction:', err)
    }
  }

  private handleListenerError() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      setTimeout(() => this.restartListener(), this.reconnectDelay * this.reconnectAttempts)
    }
    else {
      this.reset()
    }
  }

  private restartListener() {
    if (this.api?.listener) {
      try {
        this.api.listener.stop()
        this.listenerStarted = false
        this.startListener()
      }
      catch (err) {
        console.error('[ZaloService] restartListener error:', err)
        this.handleListenerError()
      }
    }
  }

  public async sendMessage(threadId: string, content: string, options?: any) {
    if (!this.api)
      throw new Error('Not logged in')
    return this.api.sendMessage(content, threadId, options)
  }

  public async logout(): Promise<void> {
    if (this.api) {
      try {
        if (this.api.listener)
          this.api.listener.stop()
        await this.api.logout()
        if (fs.existsSync(this.sessionFile))
          fs.unlinkSync(this.sessionFile)
      }
      catch (err) {
        console.error('[ZaloService] logout error:', err)
      }
      finally {
        this.reset()
      }
    }
  }

  private reset() {
    this.api = null
    this.status = 'logged_out'
    this.qrCode = null
    this.loginResolver = null
    this.listenerStarted = false
    this.reconnectAttempts = 0
  }

  public async getSessionInfo() {
    try {
      if (!fs.existsSync(this.sessionFile)) {
        return null
      }

      const raw = fs.readFileSync(this.sessionFile, 'utf-8')
      if (!raw)
        return null

      const session = JSON.parse(raw)

      return {
        userId: session.userId || null,
        loginTime: session.loginTime || null,
        isActive: session.isActive ?? false,
      }
    }
    catch (err) {
      console.error('[ZaloService] getSessionInfo error:', err)
      return null
    }
  }
}

export default ZaloService
