// index.ts (Hook file)
import { defineHook } from '@directus/extensions-sdk'
import { ZaloService } from '../endpoint/services/ZaloService'

export default defineHook(({ action, init, schedule }, { services, getSchema, logger }) => {
  const { ItemsService, FlowsService } = services
  let zaloService: ZaloService | null = null

  // Khởi tạo ZaloService khi server start
  init('app.after', async () => {
    try {
      logger.info('='.repeat(60))
      logger.info('Initializing Zalo Service...')
      logger.info('='.repeat(60))

      // Tạo instance ZaloService
      zaloService = ZaloService.getInstance()

      // Kiểm tra session cũ
      const session = await zaloService.getSessionInfo()
      if (session) {
        logger.info(`Found existing session for user: ${session.userId}`)
        logger.info(`Login time: ${session.loginTime}`)
        logger.info(`Active: ${session.isActive}`)
      }
      else {
        logger.info('No existing session found')
      }

      // Auto-login nếu được bật
      const autoLogin = process.env.ZALO_AUTO_LOGIN === 'true'
      if (autoLogin && !session) {
        logger.info('Auto-login enabled, starting login process...')

        setTimeout(async () => {
          try {
            const result = await zaloService!.login()

            if (result.qrCode) {
              logger.info('QR Code generated! Please scan with Zalo app:')
              logger.info(result.qrCode)
              logger.info('Waiting for QR scan...')
            }

            if (result.success) {
              logger.info(`Login successful! User ID: ${result.userId}`)
            }
          }
          catch (err) {
            logger.error('Auto-login failed:', err)
          }
        }, 3000) // Đợi 3s để Directus khởi động xong
      }

      logger.info('Zalo Service initialized successfully')
      logger.info('='.repeat(60))
    }
    catch (error) {
      logger.error('Failed to initialize Zalo Service:', error)
    }
  })

  // 2. Handle new messages
  action('zalo.message.new', async ({ payload, accountability }) => {
    logger.info(`New Zalo message received: ${payload.msgId}`)

    try {
      // Save message to database
      const messagesService = new ItemsService('zalo_messages', {
        schema: await getSchema(),
        accountability,
      })

      await messagesService.createOne({
        message_id: payload.msgId,
        thread_id: payload.threadId,
        sender_id: payload.senderId,
        content: payload.content,
        message_type: payload.type,
        attachments: payload.attachments,
        timestamp: new Date(payload.timestamp),
        status: 'received',
        raw_data: payload,
      })

      // Trigger flows if configured
      await triggerFlows('zalo_message_received', payload)

      // Process commands if message starts with '/'
      if (payload.content?.startsWith('/')) {
        await processCommand(payload)
      }
    }
    catch (error) {
      logger.error('Error processing message:', error)
    }
  })

  // 3. Handle reactions
  action('zalo.reaction.new', async ({ payload, accountability }) => {
    logger.info(`New reaction on message: ${payload.msgId}`)

    try {
      const reactionsService = new ItemsService('zalo_reactions', {
        schema: await getSchema(),
        accountability,
      })

      await reactionsService.createOne({
        message_id: payload.msgId,
        reactor_id: payload.reactorId,
        reaction: payload.reaction,
        timestamp: new Date(payload.timestamp),
        raw_data: payload,
      })

      // Trigger flows if configured
      await triggerFlows('zalo_reaction_received', payload)
    }
    catch (error) {
      logger.error('Error processing reaction:', error)
    }
  })

  // 4. Handle QR code generation
  action('zalo.qr.generated', async ({ payload }) => {
    logger.info('QR code generated for login')

    try {
      const settingsService = new ItemsService('zalo_settings', {
        schema: await getSchema(),
      })

      // Update QR code in settings
      await settingsService.updateOne(1, {
        qr_code: payload.qrCode,
        login_status: 'pending_qr',
        last_qr_generated: new Date(),
      })
    }
    catch (error) {
      logger.error('Error saving QR code:', error)
    }
  })

  // 5. Handle successful login
  action('zalo.login.success', async ({ payload }) => {
    logger.info(`Zalo login successful. User ID: ${payload.userId}`)

    try {
      const settingsService = new ItemsService('zalo_settings', {
        schema: await getSchema(),
      })

      await settingsService.updateOne(1, {
        user_id: payload.userId,
        login_status: 'logged_in',
        qr_code: null,
        last_login: new Date(),
      })

      // Trigger flows
      await triggerFlows('zalo_login_success', payload)
    }
    catch (error) {
      logger.error('Error updating login status:', error)
    }
  })

  // 6. Handle errors
  action('zalo.error', async ({ payload }) => {
    logger.error(`Zalo error: ${payload.type}`, payload.error)

    try {
      const logsService = new ItemsService('zalo_logs', {
        schema: await getSchema(),
      })

      await logsService.createOne({
        log_type: 'error',
        error_type: payload.type,
        message: payload.error?.message || 'Unknown error',
        details: payload,
        timestamp: new Date(),
      })
    }
    catch (error) {
      logger.error('Error logging Zalo error:', error)
    }
  })

  // 7. Handle connection lost
  action('zalo.connection.lost', async () => {
    logger.warn('Zalo connection lost')

    try {
      const settingsService = new ItemsService('zalo_settings', {
        schema: await getSchema(),
      })

      await settingsService.updateOne(1, {
        login_status: 'disconnected',
        last_disconnect: new Date(),
      })

      // Notify administrators
      await triggerFlows('zalo_connection_lost', {})
    }
    catch (error) {
      logger.error('Error handling connection loss:', error)
    }
  })

  // 8. Schedule periodic health checks
  schedule('*/5 * * * *', async () => {
    if (!zaloService)
      return

    const status = zaloService.getStatus()
    logger.debug('Zalo health check:', status)

    try {
      const settingsService = new ItemsService('zalo_settings', {
        schema: await getSchema(),
      })

      await settingsService.updateOne(1, {
        health_check: new Date(),
        is_listening: status.isListening,
        current_status: status.status,
      })

      // Auto-reconnect if disconnected
      if (status.status === 'logged_out' && process.env.ZALO_AUTO_RECONNECT === 'true') {
        logger.info('Attempting auto-reconnect...')
        await zaloService.login()
      }
    }
    catch (error) {
      logger.error('Health check error:', error)
    }
  })

  // Helper function to trigger Directus flows
  async function triggerFlows(trigger: string, payload: any) {
    try {
      const flowsService = new FlowsService({
        schema: await getSchema(),
      })

      const flows = await flowsService.readByQuery({
        filter: {
          status: { _eq: 'active' },
          trigger: { _eq: trigger },
        },
      })

      for (const flow of flows) {
        await (flowsService as any).run(flow.id, {
          payload,
        })
      }
    }
    catch (error) {
      logger.error(`Error triggering flows for ${trigger}:`, error)
    }
  }

  // Process command messages
  async function processCommand(message: any) {
    const command = message.content.split(' ')[0].substring(1).toLowerCase()

    switch (command) {
      case 'status': {
        const status = zaloService?.getStatus()
        await zaloService?.sendMessage(
          message.threadId,
          `🤖 Bot Status:\nStatus: ${status?.status}\nUser ID: ${status?.userId || 'Not logged in'}\nListening: ${status?.isListening ? 'Yes' : 'No'}`,
        )
        break
      }

      case 'help': {
        await zaloService?.sendMessage(
          message.threadId,
          `📋 Available Commands:\n/status - Check bot status\n/help - Show this help message\n/ping - Test bot response`,
        )
        break
      }

      case 'ping': {
        await zaloService?.sendMessage(message.threadId, '🏓 Pong!')
        break
      }

      default: {
        logger.debug(`Unknown command: ${command}`)
      }
    }
  }
  action('zalo.init', async () => {
    if (!zaloService) {
      throw new Error('ZaloService not initialized')
    }

    const result = await zaloService.login()

    return {
      success: result.success,
      qrCode: result.qrCode || null,
      userId: result.userId || null,
    }
  })
})
