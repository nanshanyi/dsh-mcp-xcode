// dsh-mcp-xcode — DSH host plugin bridging agents to the Xcode headless MCP
// service (`xcrun mcpbridge`) over stdio JSON-RPC 2.0.
//
// Every MCP tool Xcode advertises is registered as a DSH tool named
// `xcode_<OriginalName>` (e.g. BuildProject -> xcode_BuildProject), plus a
// `xcode_mcp_status` control tool. Requires macOS with Xcode's headless MCP
// service enabled (`xcrun mcp-server status`); the first connection must be
// approved once in the Xcode agent-permission dialog.
//
// Config (all optional):
//   clientName   - clientInfo.name shown in the Xcode permission dialog
//   bridgePath   - executable (default /usr/bin/xcrun)
//   bridgeArgs   - arguments (default ['mcpbridge'])
//   includeTools - only register tools whose names match these wildcards
//   excludeTools - never register tools whose names match these wildcards
//
// Registered tools survive bridge crashes: the next xcode_* call reconnects
// automatically, and registrations are reconciled idempotently against the
// fresh tools/list (no "already registered" collisions, stale tools dropped).
//
// Handshake verified against Xcode 27 (xcode-tools server 25280.8,
// protocolVersion 2025-06-18).
//
// This module deliberately has NO runtime dependencies: ToolDefinitions are
// plain-data contracts constructed here and validated by the harness's own
// tools registry, so the package installs cleanly into any profile.

export const name = 'dsh-mcp-xcode'

export const inject = ['subprocess', 'timer', 'tools']

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const STDOUT_STDERR_TAIL = 4000
const HANDSHAKE_TIMEOUT_MS = 30000

/** Convert a `*`/`?` wildcard pattern into an anchored RegExp. */
function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$')
}

/** Build the MCP-tool name filter from include/exclude wildcard lists. */
function buildToolFilter(include, exclude) {
  const includes = include.map(wildcardToRegExp)
  const excludes = exclude.map(wildcardToRegExp)
  return (toolName) => {
    if (includes.length > 0 && !includes.some((re) => re.test(toolName))) return false
    if (excludes.some((re) => re.test(toolName))) return false
    return true
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {object} config */
export function apply(ctx, config = {}) {
  const clientName = typeof config.clientName === 'string' && config.clientName.length > 0 ? config.clientName : 'deepseek-harness'
  const bridgePath = typeof config.bridgePath === 'string' && config.bridgePath.length > 0 ? config.bridgePath : '/usr/bin/xcrun'
  const bridgeArgs = Array.isArray(config.bridgeArgs) ? config.bridgeArgs.map(String) : ['mcpbridge']
  const toolFilter = buildToolFilter(
    Array.isArray(config.includeTools) ? config.includeTools.map(String) : [],
    Array.isArray(config.excludeTools) ? config.excludeTools.map(String) : [],
  )

  const disposers = []
  // dshName -> unregister disposer for the currently registered bridge tools.
  // Tools SURVIVE bridge restarts: on reconnect we reconcile this map against
  // the fresh tools/list (register missing names, drop stale ones), so a dead
  // bridge never leaves colliding registrations behind.
  const bridgeRegistry = new Map()
  const state = {
    handle: undefined,
    nextId: 1,
    pending: new Map(),
    lineBuf: '',
    stderrTail: '',
    tools: [],
    ready: false,
    connectPromise: undefined,
    serverInfo: undefined,
    protocolVersion: undefined,
  }
  let disposed = false
  let msgSeq = 0

  ctx.effect(() => () => {
    disposed = true
    if (state.handle) { try { state.handle.terminate() } catch (e) {} state.handle = undefined }
    state.ready = false
    for (const entry of state.pending.values()) { try { entry.reject(new Error('plugin stopped')) } catch (e) {} }
    state.pending.clear()
    const list = disposers.splice(0)
    for (const d of list) { try { d() } catch (e) {} }
    for (const unregister of bridgeRegistry.values()) { try { unregister() } catch (e) {} }
    bridgeRegistry.clear()
  })

  function writeRaw(msg) {
    if (!state.handle || !state.handle.stdin) throw new Error('mcpbridge is not running')
    state.handle.stdin.write(JSON.stringify(msg) + '\n')
  }

  function handleLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch (e) {
      state.stderrTail = (state.stderrTail + line + '\n').slice(-STDOUT_STDERR_TAIL)
      return
    }
    if (msg === null || typeof msg !== 'object') return
    const isResponse = msg.id !== undefined && msg.id !== null && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))
    if (isResponse) {
      const entry = state.pending.get(msg.id)
      if (entry) {
        state.pending.delete(msg.id)
        if (msg.error) {
          const code = msg.error && msg.error.code !== undefined ? String(msg.error.code) : ''
          const message = msg.error && msg.error.message ? String(msg.error.message) : 'unknown error'
          entry.reject(new Error('MCP error' + (code ? ' ' + code : '') + ': ' + message))
        } else {
          entry.resolve(msg.result)
        }
      }
      return
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      // server -> client request: we support none; answer method-not-found
      try { writeRaw({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported method: ' + msg.method } }) } catch (e) {}
      return
    }
    // notifications (progress/logging) are ignored; the stderr tail holds diagnostics.
  }

  function attachStreams(handle) {
    handle.stdout.setEncoding('utf8')
    handle.stdout.on('data', (chunk) => {
      state.lineBuf += chunk
      let idx
      while ((idx = state.lineBuf.indexOf('\n')) >= 0) {
        const line = state.lineBuf.slice(0, idx).replace(/\r$/, '')
        state.lineBuf = state.lineBuf.slice(idx + 1)
        if (line.trim() !== '') handleLine(line)
      }
    })
    handle.stderr.setEncoding('utf8')
    handle.stderr.on('data', (chunk) => { state.stderrTail = (state.stderrTail + chunk).slice(-STDOUT_STDERR_TAIL) })
  }

  function spawnBridge() {
    if (state.handle) return state.handle
    const handle = ctx.subprocess.spawn({
      argv: [bridgePath, ...bridgeArgs],
      cwd: '/',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5000,
    })
    state.handle = handle
    attachStreams(handle)
    const onExit = (outcome) => {
      if (state.handle !== handle) return
      state.handle = undefined
      state.ready = false
      // Keep registered tools alive: any xcode_* call triggers connect()
      // again, which re-registers idempotently through bridgeRegistry.
      const code = outcome && typeof outcome === 'object' ? outcome.exitCode : undefined
      const sig = outcome && typeof outcome === 'object' ? outcome.signal : null
      for (const entry of state.pending.values()) entry.reject(new Error('mcpbridge exited: exitCode=' + code + ' signal=' + sig + '; the next xcode_* call will reconnect automatically'))
      state.pending.clear()
    }
    handle.done.then(onExit, onExit)
    return handle
  }

  function request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer
      try { spawnBridge() } catch (e) { reject(e); return }
      const id = state.nextId++
      const settle = (fn, value) => {
        if (timer) { try { timer() } catch (e) {} timer = undefined }
        fn(value)
      }
      state.pending.set(id, { resolve: (v) => settle(resolve, v), reject: (e) => settle(reject, e) })
      try {
        writeRaw({ jsonrpc: '2.0', id, method, params: params || {} })
      } catch (e) {
        state.pending.delete(id)
        settle(reject, e)
        return
      }
      if (timeoutMs) {
        timer = ctx.timeout(() => {
          const entry = state.pending.get(id)
          if (!entry) return
          state.pending.delete(id)
          try { writeRaw({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }) } catch (e) {}
          entry.reject(new Error('MCP request "' + method + '" timed out after ' + timeoutMs + 'ms'))
        }, timeoutMs)
      }
    })
  }

  // ---- MCP JSON Schema -> DSH-enforced raw JSON Schema subset ----
  // Produces nodes within the enforced subset: scalar types, enum, object
  // properties/required/additionalProperties, array items, annotations; an
  // annotation-only node means "any JSON".
  function convertNode(node) {
    const out = {}
    if (node && typeof node === 'object' && node.description !== undefined) {
      out.description = String(node.description).slice(0, 500)
    }
    const type = node && typeof node === 'object' ? node.type : undefined
    switch (type) {
      case 'string': case 'number': case 'integer': case 'boolean': {
        out.type = type
        if (node && Array.isArray(node.enum) && node.enum.length > 0) {
          const filtered = node.enum.filter((v) => {
            if (type === 'string') return typeof v === 'string'
            if (type === 'boolean') return typeof v === 'boolean'
            if (type === 'integer') return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v) && !Object.is(v, -0)
            return typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)
          })
          if (filtered.length > 0) out.enum = filtered
        }
        break
      }
      case 'object': {
        out.type = 'object'
        const props = node && typeof node === 'object' && node.properties && typeof node.properties === 'object' ? node.properties : {}
        const req = (node && Array.isArray(node.required) ? node.required : []).filter((k) => Object.hasOwn(props, k))
        const converted = {}
        for (const key of Object.keys(props)) converted[key] = convertNode(props[key])
        out.properties = converted
        if (req.length > 0) out.required = req
        break
      }
      case 'array': {
        out.type = 'array'
        if (node && typeof node === 'object' && node.items && typeof node.items === 'object') {
          out.items = convertNode(node.items)
        }
        break
      }
      default:
        // annotation-only node: any JSON (already has description when present)
        break
    }
    return out
  }

  function convertParameters(inputSchema) {
    const properties = inputSchema && typeof inputSchema === 'object' && inputSchema.properties && typeof inputSchema.properties === 'object' ? inputSchema.properties : {}
    const required = (inputSchema && Array.isArray(inputSchema.required) ? inputSchema.required : []).filter((k) => Object.hasOwn(properties, k))
    const converted = {}
    for (const key of Object.keys(properties)) converted[key] = convertNode(properties[key])
    return {
      type: 'object',
      properties: converted,
      ...(required.length > 0 ? { required } : {}),
    }
  }

  function toDshName(mcpName) {
    return 'xcode_' + String(mcpName).replace(/[^A-Za-z0-9_]/g, '_')
  }

  // ---- result processing ----
  function base64ToBytes(b64) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  function extractText(content) {
    const parts = []
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
      }
    }
    return parts.join('\n')
  }

  async function processResult(result, exec) {
    if (result === null || typeof result !== 'object') throw new Error('invalid MCP result')
    if (result.isError === true) {
      const text = extractText(result.content)
      throw new Error('Xcode tool error: ' + (text || JSON.stringify(result).slice(0, 2000)))
    }
    const content = Array.isArray(result.content) ? result.content : []
    const textParts = []
    const rawContent = []
    const imageSummaries = []
    const imageItems = []
    for (const item of content) {
      if (item && typeof item === 'object') {
        if (item.type === 'text' && typeof item.text === 'string') {
          textParts.push(item.text)
          rawContent.push({ type: 'text', text: item.text })
        } else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
          rawContent.push({ type: 'image', mimeType: item.mimeType, bytes: item.data.length })
          imageSummaries.push({ mimeType: item.mimeType, bytes: item.data.length })
          imageItems.push(item)
        } else {
          rawContent.push(item)
        }
      } else {
        rawContent.push(item)
      }
    }
    let text = textParts.join('\n')

    // Save images as durable attachments and inject them as user content for
    // the next model step, so simulator screenshots reach the model.
    if (exec && typeof exec.deferContext === 'function' && imageItems.length > 0 && imageItems.length <= 4) {
      const attachments = ctx.get('attachments')
      if (attachments && typeof attachments.saveImage === 'function') {
        const saved = []
        for (const item of imageItems) {
          try {
            if (!MEDIA_TYPES.includes(item.mimeType)) continue
            const limits = attachments.imageLimits || {}
            if (limits.maxImageBytes && item.data.length > limits.maxImageBytes) continue
            const bytes = base64ToBytes(item.data)
            const ref = await attachments.saveImage({ data: bytes, mediaType: item.mimeType, name: 'xcode-mcp-image' })
            saved.push(ref)
          } catch (e) { /* per-image degrade */ }
        }
        if (saved.length > 0) {
          try {
            exec.deferContext({
              id: 'xcode-mcp-img-' + (++msgSeq),
              role: 'user',
              content: saved.map((ref) => ({ type: 'image', attachment: ref })),
              source: { kind: 'plugin', plugin: name },
            })
            text += (text ? '\n\n' : '') + saved.length + ' image(s) from this result were saved as attachments and injected as user content for the next step.'
          } catch (e) {
            text += (text ? '\n\n' : '') + saved.length + ' image(s) saved as attachments (injection failed: ' + e.message + ').'
          }
        }
      }
    }

    return {
      ok: true,
      text,
      raw: { content: rawContent, structuredContent: result.structuredContent, images: imageSummaries },
    }
  }

  // ---- MCP tool invocation ----
  async function callTool(mcpName, args, exec) {
    const id = state.nextId++
    const resultPromise = new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject })
      try {
        writeRaw({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: mcpName, arguments: args } })
      } catch (e) {
        state.pending.delete(id)
        reject(e)
      }
    })
    let abortListener
    if (exec && exec.signal && typeof exec.signal.addEventListener === 'function') {
      const onAbort = () => {
        try { writeRaw({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled' } }) } catch (e) {}
        const entry = state.pending.get(id)
        if (entry) { state.pending.delete(id); entry.reject(new Error('cancelled')) }
      }
      if (exec.signal.aborted) onAbort()
      else {
        abortListener = onAbort
        exec.signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    try {
      const result = await resultPromise
      return await processResult(result, exec)
    } finally {
      if (abortListener && exec && exec.signal && typeof exec.signal.removeEventListener === 'function') {
        try { exec.signal.removeEventListener('abort', abortListener) } catch (e) {}
      }
    }
  }

  function makeExecutor(mcpName) {
    return async function (args, exec) {
      if (exec && exec.signal && exec.signal.aborted) throw new Error('aborted before dispatch')
      await connect()
      return await callTool(mcpName, args || {}, exec)
    }
  }

  const OUTPUT = {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
        raw: { description: 'Raw MCP result: content items, structuredContent, image summaries (any JSON).' },
      },
      required: ['ok', 'text', 'raw'],
      additionalProperties: true,
    },
    render(args, value) {
      const text = typeof value.text === 'string' && value.text.length > 0
        ? value.text
        : String(JSON.stringify(value.raw)).slice(0, 4000)
      return [{ type: 'text', text }]
    },
  }

  // ---- connect / register ----
  async function connect() {
    if (state.ready) return { connected: true, toolCount: state.tools.length }
    if (state.connectPromise) return state.connectPromise
    state.connectPromise = (async () => {
      try {
        spawnBridge()
        const init = await request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, roots: { listChanged: true } },
          clientInfo: { name: clientName, version: '1.0.0' },
        }, HANDSHAKE_TIMEOUT_MS)
        state.serverInfo = init && init.serverInfo ? init.serverInfo : undefined
        state.protocolVersion = init && init.protocolVersion
        writeRaw({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const listed = await request('tools/list', {}, HANDSHAKE_TIMEOUT_MS)
        const advertised = listed && Array.isArray(listed.tools) ? listed.tools : []
        const filtered = advertised.filter((t) => t && typeof t.name === 'string' && toolFilter(t.name))
        state.tools = filtered
        const wanted = new Set(filtered.map((t) => toDshName(t.name)))
        // Reconcile registrations against the fresh list: drop stale names,
        // then register only the missing ones (idempotent across reconnects).
        for (const dshName of [...bridgeRegistry.keys()]) {
          if (wanted.has(dshName)) continue
          const unregister = bridgeRegistry.get(dshName)
          bridgeRegistry.delete(dshName)
          try { unregister() } catch (e) {}
        }
        const generation = []
        try {
          for (const t of filtered) {
            const dshName = toDshName(t.name)
            if (bridgeRegistry.has(dshName)) continue
            const tool = {
              name: dshName,
              description: String(t.description || 'Xcode MCP tool ' + t.name + ' (proxied from xcrun mcpbridge)').slice(0, 8000),
              parameters: convertParameters(t.inputSchema),
              output: OUTPUT,
              execute: makeExecutor(t.name),
            }
            const unregister = ctx.tools.register(tool)
            generation.push([dshName, unregister])
          }
        } catch (e) {
          // Roll back this generation on partial-registration failure so a
          // retry does not hit "already registered".
          for (const entry of generation) { try { entry[1]() } catch (err) {} }
          throw e
        }
        if (disposed) {
          for (const entry of generation) { try { entry[1]() } catch (e) {} }
        } else {
          for (const entry of generation) bridgeRegistry.set(entry[0], entry[1])
        }
        state.ready = true
        ctx.logger.info('[%s] connected to %s, %d Xcode MCP tools registered (%d skipped by filter)', name, JSON.stringify(state.serverInfo || {}), filtered.length, advertised.length - filtered.length)
        return { connected: true, toolCount: filtered.length }
      } catch (e) {
        state.ready = false
        const tail = state.stderrTail
        const hint = 'Hint: run "xcrun mcp-server status" / "xcrun mcp-server start" in a terminal, then call xcode_mcp_status with reconnect: true.'
        throw new Error(String(e && e.message ? e.message : e) + (tail ? '\nbridge stderr tail: ' + tail : '') + '\n' + hint)
      } finally {
        state.connectPromise = undefined
      }
    })()
    return state.connectPromise
  }

  const statusTool = {
    name: 'xcode_mcp_status',
    description: 'Status and control of the Xcode headless MCP bridge (xcrun mcpbridge) used by the xcode_* tools. Reports connection state, server info, registered tool count/names, and the bridge stderr tail. The bridge reconnects automatically on the next xcode_* call after a crash. Pass reconnect: true to kill the current bridge child and re-run the MCP handshake immediately. If the bridge cannot connect, run "xcrun mcp-server status" / "xcrun mcp-server start" in a terminal, then call this tool with reconnect: true.',
    parameters: {
      type: 'object',
      properties: {
        reconnect: { type: 'boolean', description: 'Restart the mcpbridge child process and re-run the MCP handshake before reporting (default false).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean' },
          serverInfo: { description: 'MCP server info from initialize, when connected (any JSON or null).' },
          protocolVersion: { description: 'Negotiated MCP protocol version, when connected (any JSON or null).' },
          toolCount: { type: 'integer' },
          tools: { type: 'array', items: { type: 'string' } },
          stderrTail: { type: 'string' },
          error: { type: 'string', description: 'Connection error message, when not connected.' },
          hint: { type: 'string', description: 'Troubleshooting hint, when not connected.' },
        },
        required: ['connected', 'toolCount', 'tools', 'stderrTail'],
        additionalProperties: true,
      },
      render(args, value) {
        const lines = ['Xcode MCP bridge: ' + (value.connected ? 'CONNECTED' : 'NOT connected')]
        if (!value.connected) {
          lines.push('error: ' + (value.error || 'unknown'))
          if (value.hint) lines.push('hint: ' + value.hint)
        }
        if (value.serverInfo) lines.push('server: ' + JSON.stringify(value.serverInfo))
        if (value.protocolVersion) lines.push('protocol: ' + value.protocolVersion)
        lines.push('registered tools: ' + value.toolCount)
        if (value.stderrTail) lines.push('bridge stderr tail: ' + value.stderrTail)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      if (args && args.reconnect === true) {
        // Terminate the current child; registered tools stay, and connect()
        // reconciles them idempotently against the fresh tools/list.
        if (state.handle) { try { state.handle.terminate() } catch (e) {} }
        state.handle = undefined
        state.ready = false
      }
      let connected = false
      let error
      if (!state.ready) {
        try { await connect(); connected = true } catch (e) { error = String(e && e.message ? e.message : e) }
      } else {
        connected = true
      }
      const out = {
        connected,
        serverInfo: state.serverInfo || null,
        protocolVersion: state.protocolVersion || null,
        toolCount: state.tools.length,
        tools: state.tools.map((t) => t.name),
        stderrTail: state.stderrTail,
      }
      if (error) {
        out.error = error
        out.hint = 'Run "xcrun mcp-server status" and "xcrun mcp-server start" in a terminal, then call xcode_mcp_status with reconnect: true.'
      }
      return out
    },
  }
  const unregisterStatus = ctx.tools.register(statusTool)
  if (disposed) { try { unregisterStatus() } catch (e) {} } else disposers.push(unregisterStatus)

  connect().then(() => {
    ctx.logger.info('[%s] ready', name)
  }).catch((e) => {
    ctx.logger.warn('[%s] initial connect failed: %s', name, e && e.message ? e.message : e)
  })
}
