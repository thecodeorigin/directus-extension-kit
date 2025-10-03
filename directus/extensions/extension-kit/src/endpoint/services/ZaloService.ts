import type { SchemaOverview } from '@directus/types'
import { match, P } from 'ts-pattern'
import { LoginQRCallbackEventType, Zalo } from 'zca-js'

export class ZaloService {
  private static instance: ZaloService | null = null

  private zalo = new Zalo({ selfListen: true, checkUpdate: false })
  private api: any = null
  private getSchemaFn: () => Promise<SchemaOverview>
  private ItemsService: any

  private status: 'logged_out' | 'pending_qr' | 'logged_in' = 'logged_out'
  private qrCode: string | null = null
  private loginResolver: ((value: any) => void) | null = null
  private listenerStarted = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 5000

  // System accountability
  private systemAccountability = {
    admin: true,
    role: null,
    user: null,
  }

  private constructor(
    getSchemaFn: () => Promise<SchemaOverview>,
    ItemsService: any,
  ) {
    this.getSchemaFn = getSchemaFn
    this.ItemsService = ItemsService
    console.log('[ZaloService] Initialized')
  }

  public static init(
    getSchemaFn: () => Promise<SchemaOverview>,
    ItemsService: any,
  ) {
    if (!ZaloService.instance) {
      ZaloService.instance = new ZaloService(getSchemaFn, ItemsService)
    }
    return ZaloService.instance
  }

  public static getInstance(): ZaloService {
    if (!ZaloService.instance) {
      throw new Error('ZaloService chưa được init')
    }
    return ZaloService.instance
  }

  public getStatus() {
    return {
      status: this.status,
      qrCode: this.qrCode,
      isListening: this.listenerStarted,
      userId: this.api?.getOwnId?.() || null,
    }
  }

  /**
   * Khởi tạo login bằng QR - trả về object status (bao gồm qrCode khi pending)
   */
  public async initiateLogin(): Promise<any> {
    if (this.status !== 'logged_out')
      return this.getStatus()

    this.status = 'pending_qr'
    console.log('[ZaloService] Starting QR login...')

    const loginPromise = new Promise<any>((resolve, reject) => {
      this.loginResolver = resolve

      const timeout = setTimeout(() => {
        reject(new Error('Login timeout'))
        this.reset()
      }, 120000)

      // Gọi zca-js loginQR (callback-based)
      this.zalo.loginQR({}, async (response: any) => {
        match(response)
          .with(
            { type: LoginQRCallbackEventType.QRCodeGenerated, data: { image: P.select(P.string) } },
            async (qrImage: string) => {
              this.qrCode = qrImage
              console.log('[ZaloService] QR code generated')
              if (this.loginResolver)
                this.loginResolver(this.getStatus())
            },
          )
          .with({ type: LoginQRCallbackEventType.QRCodeExpired }, async () => {
            clearTimeout(timeout)
            console.warn('[ZaloService] QR expired')
            this.reset()
          })
          .with({ type: LoginQRCallbackEventType.QRCodeDeclined }, async () => {
            clearTimeout(timeout)
            console.warn('[ZaloService] QR declined')
            this.reset()
          })
          .otherwise(() => {
            try {
              console.log('[ZaloService] Login event:', LoginQRCallbackEventType[response.type])
            }
            catch {
              console.log('[ZaloService] Login event (unknown):', response)
            }
          })
      })
        .then(async (api: any) => {
          clearTimeout(timeout)
          this.api = api
          this.status = 'logged_in'
          this.qrCode = null
          console.log(`[ZaloService] Logged in as: ${this.api.getOwnId?.() || 'unknown'}`)
          this.startListener()

          // Đồng bộ avatar & groups sau khi login
          try {
            const ownId = this.api.getOwnId?.()
            if (ownId)
              await this.fetchAndUpsertUser(ownId)
            await this.syncGroupAvatars()
          }
          catch (err) {
            console.warn('[ZaloService] sync after login failed', err)
          }

          if (this.loginResolver)
            this.loginResolver(this.getStatus())
          resolve(this.getStatus())
        })
        .catch((err: any) => {
          clearTimeout(timeout)
          console.error('[ZaloService] Login failed:', err)
          this.reset()
          reject(err)
        })
    })
    return loginPromise
  }

  /** Bắt đầu lắng nghe tin nhắn/reaction */
  private startListener() {
    if (!this.api || this.listenerStarted)
      return

    this.listenerStarted = true
    try {
      this.api.listener
        .on('message', async (msg: any) => {
          try {
            await this.handleIncomingMessage(msg.data || msg)
          }
          catch (error) {
            console.error('[ZaloService] Error handling message:', error)
          }
        })
        .on('reaction', async (react: any) => {
          try {
            await this.handleIncomingReaction(react.data || react)
          }
          catch (error) {
            console.error('[ZaloService] Error handling reaction:', error)
          }
        })
        .on('error', async (error: any) => {
          console.error('[ZaloService] Listener error:', error)
          this.handleListenerError()
        })
        .start()

      this.reconnectAttempts = 0
    }
    catch (err) {
      this.listenerStarted = false
      console.error('[ZaloService] startListener failed:', err)
      this.handleListenerError()
    }
  }

  /** Xử lý tin nhắn đến - tạo các items bằng ItemsService */
  private async handleIncomingMessage(rawData: any) {
    try {
      const schema = await this.getSchemaFn()
      // Parse fields từ Zalo format - map nhiều biến thể
      const messageId = rawData.msgId
      const senderId = rawData.uidFrom
      const recipientId = rawData.idTo
      const displayName = rawData.dName
      const content = typeof rawData.content === 'string'
        ? rawData.content
        : (rawData.content || '')
      const timestamp = Number.parseInt(rawData.ts ?? rawData.t ?? `${Date.now()}`)
      const clientMsgId = rawData.cliMsgId
      const attachments = rawData.attachments || rawData.files || []

      const userIds = [senderId, recipientId].filter(Boolean).sort()
      const conversationId = userIds.length === 2
        ? `direct_${userIds[0]}_${userIds[1]}`
        : `thread_${recipientId || senderId}`

      console.log('[ZaloService] Processing message:', {
        displayName,
      })

      // 1. Upsert conversation
      await this.upsertConversation(conversationId, rawData, schema, senderId, recipientId)

      // 2. Fetch và upsert sender từ Zalo API
      await this.fetchAndUpsertUser(senderId, schema)

      // 3. Upsert recipient if different
      if (recipientId && recipientId !== senderId) {
        await this.fetchAndUpsertUser(recipientId, schema)
      }

      // 4. Create message bằng ItemsService
      const messagesService = new this.ItemsService('zalo_messages', {
        schema,
        accountability: this.systemAccountability,
      })

      // Check if message exists
      const existingMessages = await messagesService.readByQuery({
        filter: { id: { _eq: messageId } },
        limit: 1,
      })

      if (existingMessages.length === 0) {
        await messagesService.createOne({
          id: messageId,
          client_id: clientMsgId || messageId,
          conversation_id: conversationId,
          sender_id: senderId,
          content,
          raw_data: rawData,
          mentions: null,
          forward_from_message_id: null,
          reply_to_message_id: null,
          is_edited: false,
          is_undone: false,
          sent_at: new Date(timestamp),
          received_at: new Date(),
          edited_at: null,
        })
      }

      // 5. Create attachments nếu có
      if (Array.isArray(attachments) && attachments.length > 0) {
        await this.createAttachments(messageId, attachments, schema)
      }

      // 6. Update conversation last message
      await this.updateConversationLastMessage(
        conversationId,
        messageId,
        new Date(timestamp),
        schema,
      )
    }
    catch (error) {
      console.error('[ZaloService] Error handling message:', error)
    }
  }

  private async upsertConversation(
    conversationId: string,
    rawData: any,
    schema: SchemaOverview,
    senderId?: string,
    recipientId?: string,
  ) {
    try {
      const conversationsService = new this.ItemsService('zalo_conversations', {
        schema,
        accountability: this.systemAccountability,
      })

      // Check if exists
      const existing = await conversationsService.readByQuery({
        filter: { id: { _eq: conversationId } },
        limit: 1,
      })

      if (existing.length === 0) {
        await conversationsService.createOne({
          id: conversationId,
          type: 'direct',
          participant_id: recipientId || null,
          group_id: rawData.groupId || rawData.threadId || null,
          is_pinned: false,
          is_muted: false,
          is_archived: false,
          is_hidden: false,
          unread_count: 0,
        })
      }
    }
    catch (error) {
      console.error('[ZaloService] Error upserting conversation:', error)
    }
  }

  /** Fetch user info từ Zalo API và upsert vào DB bằng ItemsService */
  private async fetchAndUpsertUser(userId: string, schema?: SchemaOverview) {
    if (!this.api) {
      console.warn('[ZaloService] API not available, creating basic user record')
      await this.createBasicUser(userId)
      return
    }

    try {
    // Lấy schema nếu chưa có
      const currentSchema = schema || await this.getSchemaFn()
      // Gọi zca-js API để lấy thông tin user
      let userInfo: any = null

      try {
      // Chỉ dùng getUserInfo - method chính thức của zca-js
        const apiResponse = await this.api.getUserInfo(userId)
        // Parse response - ưu tiên changed_profiles
        userInfo = apiResponse?.changed_profiles?.[userId] || apiResponse || null
      }
      catch (err: any) {
        console.warn('[ZaloService] Failed to fetch user info:', err.message)
        userInfo = null
      }

      // Helper function to parse date
      const parseDateOfBirth = (dob: any): Date | null => {
        if (!dob)
          return null

        try {
        // Unix timestamp (milliseconds or seconds)
          if (typeof dob === 'number' && dob > 0) {
            return new Date(dob > 9999999999 ? dob : dob * 1000)
          }

          // DD/MM/YYYY format
          if (typeof dob === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(dob)) {
            const [day, month, year] = dob.split('/').map(Number)
            const date = new Date(year, month - 1, day)

            // Validate date
            if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) {
              return date
            }
          }

          // ISO string or other formats
          const date = new Date(dob)
          return isNaN(date.getTime()) ? null : date
        }
        catch {
          return null
        }
      }

      // Map dữ liệu từ Zalo API - chỉ dùng field chính
      const displayName = userInfo?.displayName || 'Unknown User'
      const avatarUrl = userInfo?.avatar
      const coverUrl = userInfo?.cover
      const alias = userInfo?.username
      const dateOfBirth = parseDateOfBirth(userInfo?.sdob || userInfo?.dob)
      const isFriend = userInfo?.isFr === 1 || false
      const lastOnline = userInfo?.lastActionTime ? new Date(Number(userInfo.lastActionTime)) : null
      const statusMessage = userInfo?.status || null
      const zaloName = userInfo?.zaloName

      // Tạo ItemsService
      const usersService = new this.ItemsService('zalo_users', {
        schema: currentSchema,
        accountability: this.systemAccountability,
      })

      // Check if user exists
      const existingUsers = await usersService.readByQuery({
        filter: { id: { _eq: userId } },
        limit: 1,
      })

      const userData = {
        display_name: displayName,
        avatar_url: avatarUrl,
        cover_url: coverUrl,
        alias,
        date_of_birth: dateOfBirth,
        is_friend: isFriend,
        last_online: lastOnline,
        status_message: statusMessage,
        zalo_name: zaloName,
        raw_data: userInfo,
      }

      if (existingUsers.length === 0) {
      // Insert mới
        await usersService.createOne({
          id: userId,
          ...userData,
        })
      }
      else if (userInfo) {
      // Update chỉ khi có thông tin mới
        await usersService.updateOne(userId, userData)
      }
    }
    catch (error) {
      console.error('[ZaloService] Error in fetchAndUpsertUser:', error)
      // Fallback: tạo user cơ bản
      await this.createBasicUser(userId)
    }
  }

  /** Tạo user cơ bản khi không fetch được từ API - dùng ItemsService */
  private async createBasicUser(userId: string) {
    try {
      const schema = await this.getSchemaFn()

      const usersService = new this.ItemsService('zalo_users', {
        schema,
        accountability: this.systemAccountability,
      })

      // Check if exists
      const existing = await usersService.readByQuery({
        filter: { id: { _eq: userId } },
        limit: 1,
      })

      if (existing.length === 0) {
        await usersService.createOne({
          id: userId,
          display_name: 'Unknown User',
          avatar_url: null,
          cover_url: null,
          alias: null,
          date_of_birth: null,
          is_friend: false,
          last_online: null,
          status_message: null,
          zalo_name: null,
          raw_data: null,
        })
      }
    }
    catch (error) {
      console.error('[ZaloService] Error creating basic user:', error)
    }
  }

  public async syncGroupAvatars() {
    if (!this.api) {
      console.warn('[ZaloService] API not available for syncGroupAvatars')
      return
    }

    try {
      const schema = await this.getSchemaFn()

      // Method đúng: getAllGroups
      if (typeof this.api.getAllGroups !== 'function') {
        console.error('[ZaloService] getAllGroups method not found')
        return
      }

      const res = await this.api.getAllGroups()

      // Parse gridVerMap để lấy group IDs
      const gridVerMap = res?.gridVerMap || {}
      const groupIds = Object.keys(gridVerMap)

      if (groupIds.length === 0) {
        console.warn('[ZaloService] No groups found in gridVerMap')
        return
      }

      // Tạo ItemsService
      const groupsService = new this.ItemsService('zalo_groups', {
        schema,
        accountability: this.systemAccountability,
      })

      // Fetch thông tin chi tiết cho từng group
      for (const groupId of groupIds) {
        try {
          // Gọi getGroupInfo để lấy chi tiết group
          let groupInfo: any = null

          if (typeof this.api.getGroupInfo === 'function') {
            groupInfo = await this.api.getGroupInfo(groupId)
          }
          else {
            console.warn('[ZaloService] getGroupInfo not available, using basic data')
          }
          const group = groupInfo?.gridInfoMap?.[groupId]

          // Map dữ liệu
          const avatarUrl = group?.fullAvt || group?.avt
          const name = group?.name || `Group ${groupId}`
          const description = group?.desc
          const inviteLink = group?.inviteLink || group?.link || null
          const ownerId = group?.creatorId
          const createdAtZalo = group?.createdTime
          const settings = group?.setting
          const totalMembers = group?.totalMember

          // Check if exists
          const existing = await groupsService.readByQuery({
            filter: { id: { _eq: groupId } },
            limit: 1,
          })

          const groupData = {
            avatar_url: avatarUrl,
            name,
            description,
            invite_link: inviteLink,
            owner_id: ownerId,
            created_at_zalo: createdAtZalo ? new Date(Number(createdAtZalo)) : null,
            settings,
            total_members: totalMembers,
          }

          if (existing.length === 0) {
            await groupsService.createOne({
              id: groupId,
              ...groupData,
            })
          }
          else {
            await groupsService.updateOne(groupId, groupData)
          }
        }
        catch (groupError) {
          console.error('[ZaloService] ❌ Error processing group', groupId, ':', groupError)
        }
      }
    }
    catch (err) {
      console.error('[ZaloService] syncGroupAvatars fatal error:', err)
    }
  }

  private async createAttachments(messageId: string, attachments: any[], schema: SchemaOverview) {
    try {
      if (!Array.isArray(attachments) || attachments.length === 0)
        return

      const attachmentsService = new this.ItemsService('zalo_attachments', {
        schema,
        accountability: this.systemAccountability,
      })

      for (const att of attachments) {
        await attachmentsService.createOne({
          message_id: messageId,
          type: att.type || 'file',
          url: att.url || att.link || att.href || '',
          file_name: att.fileName || att.name || att.title || null,
          file_size: att.fileSize || att.size || null,
          mime_type: att.mimeType || att.type || null,
          thumbnail_url: att.thumbnailUrl || att.thumb || null,
          width: att.width || null,
          height: att.height || null,
          duration: att.duration || null,
          metadata: att.metadata || null,
        })
      }
      console.log(`[ZaloService] Created ${attachments.length} attachments via ItemsService`)
    }
    catch (error) {
      console.error('[ZaloService] Error creating attachments:', error)
    }
  }

  private async updateConversationLastMessage(
    conversationId: string,
    messageId: string,
    messageTime: Date,
    schema: SchemaOverview,
  ) {
    try {
      const conversationsService = new this.ItemsService('zalo_conversations', {
        schema,
        accountability: this.systemAccountability,
      })

      await conversationsService.updateOne(conversationId, {
        last_message_id: messageId,
        last_message_time: messageTime,
      })
    }
    catch (error) {
      console.error('[ZaloService] Error updating conversation last message:', error)
    }
  }

  private async handleIncomingReaction(rawData: any) {
    try {
      console.log('[ZaloService] Full reaction data:', JSON.stringify(rawData, null, 2))

      const messageId = rawData.msgId
      const userId = rawData.uidFrom
      const reactionIcon = rawData?.content?.rIcon ?? null
      if (!messageId || !userId)
        return

      const schema = await this.getSchemaFn()

      const reactionsService = new this.ItemsService('zalo_reactions', {
        schema,
        accountability: this.systemAccountability,
      })

      await reactionsService.createOne({
        message_id: messageId,
        user_id: userId,
        reaction_icon: reactionIcon,
      })

      console.log('[ZaloService] Created reaction via ItemsService')
    }
    catch (error) {
      console.error('[ZaloService] Error handling reaction:', error)
    }
  }

  private handleListenerError() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++
      const delay = this.reconnectDelay * this.reconnectAttempts
      console.warn(`[ZaloService] Listener error - will retry in ${delay}ms (attempt ${this.reconnectAttempts})`)
      setTimeout(() => this.restartListener(), delay)
    }
    else {
      console.error('[ZaloService] Max reconnect attempts reached, resetting service')
      this.reset()
    }
  }

  private restartListener() {
    if (this.api && this.api.listener) {
      try {
        this.api.listener.stop()
        this.listenerStarted = false
        this.startListener()
      }
      catch (err) {
        console.error('[ZaloService] restartListener failed', err)
        this.handleListenerError()
      }
    }
    else {
      this.handleListenerError()
    }
  }

  public async sendMessage(threadId: string, content: string, options?: any): Promise<any> {
    if (!this.api) {
      throw new Error('Not logged in')
    }

    const sendFns = [
      this.api.sendMessage?.bind(this.api),
      this.api.messaging?.sendMessage?.bind(this.api.messaging),
      this.api.send?.bind(this.api),
    ].filter(Boolean)

    for (const fn of sendFns) {
      try {
        return await fn(threadId, content, options)
      }
      catch {
        // thử tiếp
      }
    }
    throw new Error('sendMessage failed: no compatible send function or all attempts failed')
  }

  public async logout(): Promise<void> {
    if (this.api) {
      try {
        if (this.api.listener)
          this.api.listener.stop()
        await this.api.logout?.()
      }
      catch (err) {
        console.warn('[ZaloService] Error during logout', err)
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
}

export default ZaloService
