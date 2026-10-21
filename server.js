#!/usr/bin/env node
import path from 'node:path'
import { createGateway } from './src/app.js'

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'))

const gateway = await createGateway({ dataDir, env: process.env })
const host = gateway.host === '0.0.0.0' ? '127.0.0.1' : gateway.host
const base = `http://${host}:${gateway.port}`

console.log('')
console.log('  Cline Manager 已启动')
console.log(`  管理后台:   ${base}/admin`)
console.log(`  OpenAI 兼容: ${base}/v1`)
console.log(`  上游地址:   ${gateway.ctx.config.upstream.baseURL}`)
console.log(`  数据目录:   ${dataDir}`)
if (gateway.bootstrap.createdAdminToken) {
  console.log('')
  console.log(`  管理员令牌（仅本次显示，已写入 ${path.join(dataDir, 'config.json')}）:`)
  console.log(`    ${gateway.bootstrap.createdAdminToken}`)
}
if (gateway.bootstrap.createdKey) {
  console.log('')
  console.log('  已生成第一个接入 API Key（仅本次显示，请立即保存）:')
  console.log(`    ${gateway.bootstrap.createdKey}`)
}
console.log('')

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  console.log(`\n收到 ${signal}，正在关闭…`)
  await gateway.close()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
