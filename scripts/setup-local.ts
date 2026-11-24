import { createApp } from '../server/app.js'
import { bootstrap } from '../server/bootstrap.js'
const runtime = createApp()
try { await bootstrap(runtime.ctx); console.info('本地管理员初始化完成；凭据只保存在本机私有目录，不属于交付包。') }
finally { runtime.close() }
