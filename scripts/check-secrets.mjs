#!/usr/bin/env node
/**
 * 发布前扫描：包里不能出现 Folia 的 OBS token。
 *
 * 这个 token 等价于「能看正在放什么」的通行证，而且它随机器不同。所以不写死字符串，
 * 而是发布时读本机的 %APPDATA%\Folia\config.json 取当前值，再在待发布文件里找。
 * 换一台机器发布时自然比对的是那台机器的 token。
 *
 * 额外查一遍通用形状（长 base64url、常见密钥前缀），防的是别的东西被抄进来。
 * 只读，不改文件。发现命中就以非零码退出，npm 会中止发布。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* package.json 的 files 字段就是发布内容。逐个展开，避免扫到 node_modules / .git。 */
function listPublished(dir, files) {
  const out = []
  for (const entry of files) {
    if (entry.includes('*')) {
      const [prefix, pattern] = entry.split('/')
      const sub = join(dir, prefix)
      if (!existsSync(sub)) continue
      const suffix = pattern.replace('*', '')
      for (const name of readdirSync(sub)) {
        if (name.endsWith(suffix)) out.push(join(sub, name))
      }
      continue
    }
    const full = join(dir, entry)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full)) out.push(join(full, name))
    } else {
      out.push(full)
    }
  }
  /* npm 总会带上这两个。 */
  for (const extra of ['package.json', 'LICENSE']) {
    const full = join(dir, extra)
    if (existsSync(full)) out.push(full)
  }
  return [...new Set(out)]
}

function localObsToken() {
  const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  try {
    const config = JSON.parse(readFileSync(join(base, 'Folia', 'config.json'), 'utf8'))
    const token = config?.OBS_BROWSER_SOURCE_TOKEN
    return typeof token === 'string' && token.length >= 16 ? token : null
  } catch {
    return null
  }
}

const GENERIC = [
  /* 长 base64url 串。Folia 的 token 是 32 字节 = 43 字符，混有大写、小写和数字；
     要求同时出现数字，避免把 WinRT 那种 GlobalSystemMediaTransport… 类型名算进来。 */
  { name: 'base64url-looking secret', re: /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])\b[A-Za-z0-9_-]{40,50}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { name: 'API key assignment', re: /(?:api[_-]?key|secret|password)\s*[:=]\s*['"][^'"\s]{16,}['"]/i },
]

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const files = listPublished(ROOT, pkg.files ?? [])
const token = localObsToken()
const problems = []

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const where = relative(ROOT, file)
  if (token !== null && text.includes(token)) {
    problems.push(`${where}: contains this machine's Folia OBS token`)
  }
  for (const { name, re } of GENERIC) {
    const match = re.exec(text)
    if (match) problems.push(`${where}: looks like a ${name} (${match[0].slice(0, 12)}…)`)
  }
}

if (problems.length > 0) {
  console.error('refusing to publish — secret scan failed:')
  for (const line of problems) console.error(`  ${line}`)
  process.exit(1)
}

console.log(`secret scan clean: ${files.length} files, token ${token === null ? 'not available locally' : 'compared'}`)
