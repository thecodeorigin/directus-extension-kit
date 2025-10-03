import { defineEndpoint } from '@directus/extensions-sdk'
import ZaloService from './services/ZaloService'

export default defineEndpoint((router, { getSchema, services }) => {
  const { ItemsService } = services

  // Truyền ItemsService vào init
  const zaloService = ZaloService.init(getSchema, ItemsService)

  router.post('/init', async (req, res) => {
    try {
      const status = await zaloService.initiateLogin()
      res.json(status)
    }
    catch (error) {
      res.status(500).json({ error: (error as Error).message })
    }
  })

  router.get('/status', (req, res) => {
    res.json(zaloService.getStatus())
  })
})
