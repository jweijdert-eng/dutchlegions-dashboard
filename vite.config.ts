import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { IncomingMessage, ServerResponse } from 'http'

const EVE_LOG_DIR = path.join(os.homedir(), 'Documents', 'EVE', 'logs', 'Gamelogs')

function listLogFiles() {
  try {
    return fs.readdirSync(EVE_LOG_DIR)
      .filter(f => f.endsWith('.txt'))
      .map(f => {
        const stat = fs.statSync(path.join(EVE_LOG_DIR, f))
        return { name: f, size: stat.size, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 30)
  } catch {
    return null
  }
}

function serveList(res: ServerResponse) {
  const files = listLogFiles()
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (!files) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'EVE log directory not found', dir: EVE_LOG_DIR }))
    return
  }
  res.end(JSON.stringify(files))
}

function serveLog(req: IncomingMessage, res: ServerResponse) {
  const urlObj = new URL(req.url ?? '/', 'http://localhost')
  const fileName = urlObj.searchParams.get('file')
  res.setHeader('Access-Control-Allow-Origin', '*')

  let targetPath: string
  let targetName: string
  if (fileName) {
    targetPath = path.join(EVE_LOG_DIR, path.basename(fileName))
    targetName = path.basename(fileName)
  } else {
    const files = listLogFiles()
    if (!files || files.length === 0) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'No EVE log files found', dir: EVE_LOG_DIR }))
      return
    }
    targetPath = path.join(EVE_LOG_DIR, files[0].name)
    targetName = files[0].name
  }

  try {
    const stat = fs.statSync(targetPath)
    const buf  = fs.readFileSync(targetPath)
    // EVE log files on Windows are UTF-16 LE (BOM: 0xFF 0xFE)
    const isUtf16 = buf[0] === 0xFF && buf[1] === 0xFE
    const content = isUtf16 ? buf.slice(2).toString('utf16le') : buf.toString('utf8')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Log-File', targetName)
    res.setHeader('X-Log-Size', String(stat.size))
    res.end(content)
  } catch {
    res.statusCode = 500
    res.end(JSON.stringify({ error: `Could not read ${targetName}` }))
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'eve-log-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url ?? ''
          if (url === '/api/eve-log/list') {
            serveList(res)
          } else if (url === '/api/eve-log' || url.startsWith('/api/eve-log?')) {
            serveLog(req, res)
          } else {
            next()
          }
        })
      },
    },
  ],
  server: { port: 8080 },
})
