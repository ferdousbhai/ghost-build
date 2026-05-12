import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/preview/$workerName/api/health')({
  server: {
    handlers: {
      GET: async ({ params }) =>
        Response.json({
          status: 'ok',
          worker: params.workerName,
          preview: true,
        }),
    },
  },
})
