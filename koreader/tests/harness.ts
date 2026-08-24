/**
 * Runs the plugin's pure Lua modules under a Lua VM, so the parts of this
 * feature that live in Lua are not tested only by hand on a Kindle.
 *
 * Only the modules that `require` nothing from KOReader can run here, which is
 * why `marginalia_prompt.lua` and `marginalia_payload.lua` were written that
 * way: the prompt's injection fence and the export's identity scheme are
 * exactly the parts where a quiet mistake is expensive and a device is a bad
 * place to look for one. `marginalia_tls.lua` joins them with a stub for
 * LuaSocket, since its hostname matching is pure once the module has loaded.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error fengari ships no types
import { lauxlib, lua, lualib, to_luastring } from 'fengari'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..', 'marginalia.koplugin')

/** Loaded in dependency order; each is put into `package.loaded` under its name. */
const MODULES = ['marginalia_prompt', 'marginalia_payload', 'marginalia_tls', 'marginalia_view']

/**
 * Stands in for the KOReader modules the pure files touch.
 *
 * `socket.try` is the only one with behaviour that matters: LuaSocket's version
 * raises so that `socket.protect` around `http.request` can turn the failure
 * back into `nil, message`, and the TLS module relies on that.
 */
const STUBS = `
package.loaded["logger"] = setmetatable({}, { __index = function() return function() end end })
package.loaded["socket"] = {
  try = function(ok, err) if not ok then error(err, 0) end end,
}
`

function check(L: unknown, status: number, what: string): void {
  if (status !== lua.LUA_OK) {
    const message = lua.lua_tojsstring(L, -1)
    throw new Error(`${what}: ${message}`)
  }
}

function defineModule(L: unknown, name: string, directory = pluginDir): void {
  const source = readFileSync(join(directory, `${name}.lua`))
  check(L, lauxlib.luaL_loadbuffer(L, source, null, to_luastring(`@${name}.lua`)), `loading ${name}`)
  check(L, lua.lua_pcall(L, 0, 1, 0), `running ${name}`)

  lua.lua_getglobal(L, to_luastring('package'))
  lua.lua_getfield(L, -1, to_luastring('loaded'))
  lua.lua_pushvalue(L, -3)
  lua.lua_setfield(L, -2, to_luastring(name))
  lua.lua_pop(L, 3)
}

/**
 * Runs one `.lua` spec and returns whatever it printed.
 *
 * A spec reports a failure by calling `error`, which surfaces here as a thrown
 * exception carrying the Lua message and line — so a broken assertion reads
 * like any other test failure rather than a silent zero.
 */
export function runSpec(name: string): string {
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)

  const printed: string[] = []
  lua.lua_pushcfunction(L, (state: unknown) => {
    const count = lua.lua_gettop(state)
    const parts: string[] = []
    for (let i = 1; i <= count; i += 1) {
      parts.push(String(lua.lua_tojsstring(state, i) ?? lua.lua_tonumber(state, i)))
    }
    printed.push(parts.join('\t'))
    return 0
  })
  lua.lua_setglobal(L, to_luastring('print'))

  check(L, lauxlib.luaL_loadbuffer(L, to_luastring(STUBS), null, to_luastring('@stubs')), 'loading stubs')
  check(L, lua.lua_pcall(L, 0, 0, 0), 'running stubs')

  for (const module of MODULES) defineModule(L, module)
  defineModule(L, 'spec_helper', here)

  const source = readFileSync(join(here, `${name}.lua`))
  check(L, lauxlib.luaL_loadbuffer(L, source, null, to_luastring(`@${name}.lua`)), `loading ${name}`)
  check(L, lua.lua_pcall(L, 0, 0, 0), `${name}`)

  return printed.join('\n')
}
