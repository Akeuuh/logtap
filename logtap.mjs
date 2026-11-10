#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { createInterface, emitKeypressEvents } from 'node:readline'
import { stripVTControlCharacters as strip } from 'node:util'

const OPEN = '──── ▶'
const CLOSE = '──── ■'
const MARK_RE = /^──── (▶|■) \S+ (.*)$/
const HELP = 'f filtre  / recherche  n/N suivant  m groupe  c copier  y copier groupe  ↑↓ PgUp PgDn g G  q quitter'

const usage = () => {
  console.error(`usage:
  logtap [-f regex] [-o fichier] -- <commande...>
  logtap extract <fichier> <label>

touches :
  f        ne garder que les lignes qui matchent (vide = tout)
  /        rechercher (surligne), n / N = occurrence précédente / suivante, Échap = effacer
  m        ouvre un groupe (demande un nom) / ferme le groupe ouvert
  c        copie les lignes affichées (filtre appliqué)
  y        copie le dernier groupe (en cours ou fermé)
  ↑↓ PgUp PgDn g G   défiler, G = revenir en bas et suivre
  q        quitter`)
  process.exit(1)
}

function extract(file, label) {
  if (!file || !label) usage()
  let inside = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(MARK_RE)
    if (m?.[1] === '▶') inside = m[2].includes(label)
    if (inside) console.log(line)
    if (m?.[1] === '■') inside = false
  }
}

// shortcut: pbcopy = macOS uniquement, passer par xclip/clip.exe si besoin ailleurs
const copy = text =>
  new Promise((resolve, reject) => {
    const p = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('error', reject).on('exit', resolve)
    p.stdin.end(text)
  })

// shortcut: emoji et caractères larges comptent pour 1 colonne, une ligne qui en contient peut déborder
function wrap(str, width) {
  const rows = ['']
  let col = 0
  let sgr = ''
  for (const [tok] of str.matchAll(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu)) {
    if (tok.startsWith('\x1b')) {
      if (!tok.endsWith('m')) continue
      sgr = tok === '\x1b[0m' || tok === '\x1b[m' ? '' : sgr + tok
      rows[rows.length - 1] += tok
      continue
    }
    if (col === width) {
      rows[rows.length - 1] += '\x1b[0m'
      rows.push(sgr)
      col = 0
    }
    rows[rows.length - 1] += tok
    col++
  }
  return rows.map(r => r + '\x1b[0m')
}

const fit = (text, width) => (text.length > width ? text.slice(0, width - 1) + '…' : text.padEnd(width))

function run(argv) {
  let filter = null
  let out = `logtap-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
  while (argv[0]?.startsWith('-')) {
    const flag = argv.shift()
    if (flag === '--') break
    if (flag === '-f') filter = new RegExp(argv.shift(), 'i')
    else if (flag === '-o') out = argv.shift()
    else usage()
  }
  if (!argv.length) usage()

  const file = createWriteStream(out, { flags: 'a' })
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  child.on('error', err => {
    console.error(err.message)
    process.exit(1)
  })

  const onLine = handler => {
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', line => {
        const raw = line.replace(/\t/g, '  ').replace(/\r/g, '')
        const plain = strip(raw)
        file.write(plain + '\n')
        handler({ raw, plain })
      })
    }
  }

  const tty = process.stdin.isTTY && process.stdout.isTTY
  if (!tty) {
    onLine(e => (!filter || filter.test(e.plain)) && console.log(e.raw))
    child.on('exit', code => file.end(() => process.exit(code ?? 0)))
    return
  }

  const entries = []
  const groups = []
  let visible = []
  let search = null
  let prompt = null
  let message = ''
  let messageTimer
  let offset = 0
  let exitCode
  let quitting = false
  let kills = 0
  let renderQueued = false

  const keep = e => e.mark || !filter || filter.test(e.plain)
  const groupIsOpen = () => groups.length > 0 && groups.at(-1).end === undefined
  const bodyHeight = () => process.stdout.rows - 3
  const clampOffset = value => Math.max(0, Math.min(visible.length - 1, value))

  const display = e => {
    if (e.mark) return `\x1b[1;30;45m ${e.plain} \x1b[0m`
    if (!search?.test(e.plain)) return e.raw
    const all = new RegExp(search.source, 'gi')
    return `\x1b[30;43m▌\x1b[0m ${e.plain.replace(all, m => (m ? `\x1b[1;30;43m${m}\x1b[0m` : m))}`
  }

  const render = () => {
    const width = process.stdout.columns
    const height = bodyHeight()
    let rows = []
    for (let i = visible.length - 1 - offset; i >= 0 && rows.length < height; i--) {
      rows = wrap(display(visible[i]), width).concat(rows)
    }
    rows = rows.slice(-height)
    while (rows.length < height) rows.push('')

    const header = [
      ' logtap',
      argv.join(' '),
      exitCode === undefined ? '● en cours' : `✗ terminé (${exitCode})`,
      `${visible.length}/${entries.length} lignes`,
      filter && `filtre /${filter.source}/`,
      search && `recherche /${search.source}/`,
      groupIsOpen() && `● groupe « ${groups.at(-1).label} »`,
      offset > 0 && `↑ ${offset} (G pour suivre)`,
    ]
      .filter(Boolean)
      .join('  │  ')

    const status = prompt
      ? `\x1b[1;33m${prompt.kind === 'filter' ? 'filtre' : prompt.kind === 'search' ? 'recherche' : 'nom du groupe'} › \x1b[0m${prompt.text}\x1b[7m \x1b[0m`
      : `\x1b[36m${message}\x1b[0m`

    const lines = [`\x1b[1;37;44m${fit(header, width)}\x1b[0m`, ...rows, status, `\x1b[2m${fit(HELP, width)}\x1b[0m`]
    process.stdout.write(lines.map((l, i) => `\x1b[${i + 1};1H\x1b[2K${l}`).join(''))
  }

  const scheduleRender = () => {
    if (renderQueued) return
    renderQueued = true
    setTimeout(() => {
      renderQueued = false
      render()
    }, 30)
  }

  const flash = text => {
    message = text
    clearTimeout(messageTimer)
    messageTimer = setTimeout(() => {
      message = ''
      render()
    }, 3000)
    render()
  }

  const add = e => {
    entries.push(e)
    if (!keep(e)) return
    visible.push(e)
    if (offset > 0) offset++
    scheduleRender()
  }

  const refilter = () => {
    visible = entries.filter(keep)
    offset = 0
  }

  const marker = (symbol, label) => {
    const plain = `${symbol} ${new Date().toISOString()} ${label}`
    file.write(plain + '\n')
    add({ raw: plain, plain, mark: true })
  }

  const toggleGroup = label => {
    if (groupIsOpen()) {
      const g = groups.at(-1)
      g.end = entries.length
      marker(CLOSE, `${g.label} (${g.end - g.start} lignes)`)
    } else {
      const g = { label: label || `groupe ${groups.length + 1}`, start: entries.length + 1 }
      groups.push(g)
      marker(OPEN, g.label)
    }
  }

  const copyLines = async (selected, what) => {
    try {
      await copy(selected.join('\n'))
      flash(`copié : ${selected.length} lignes (${what})`)
    } catch (err) {
      flash(`copie impossible : ${err.message}`)
    }
  }

  const jump = (from, dir) => {
    for (let i = from; i >= 0 && i < visible.length; i += dir) {
      if (!visible[i].mark && search.test(visible[i].plain)) {
        offset = visible.length - 1 - i
        return render()
      }
    }
    flash(`plus d'occurrence ${dir < 0 ? 'au-dessus' : 'en dessous'}`)
  }

  const restore = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    process.stdin.setRawMode(false)
  }

  const exit = () => {
    restore()
    file.end(() => {
      console.log(`log complet : ${out}`)
      process.exit(exitCode ?? 0)
    })
  }

  const quit = () => {
    if (exitCode !== undefined) return exit()
    quitting = true
    child.kill(kills++ ? 'SIGKILL' : 'SIGINT')
  }

  child.on('exit', (code, signal) => {
    exitCode = code ?? signal
    if (quitting) return exit()
    render()
  })

  const submit = () => {
    const { kind, text } = prompt
    if (kind === 'group') {
      prompt = null
      return toggleGroup(text.trim())
    }
    let regex = null
    try {
      regex = text ? new RegExp(text, 'i') : null
    } catch (err) {
      return flash(err.message)
    }
    prompt = null
    if (kind === 'filter') {
      filter = regex
      refilter()
      return render()
    }
    search = regex
    if (search) jump(visible.length - 1 - offset, -1)
    else render()
  }

  const onKey = (str, key = {}) => {
    if (key.ctrl && key.name === 'c') return quit()

    if (prompt) {
      if (key.name === 'return') return submit()
      if (key.name === 'escape') prompt = null
      else if (key.name === 'backspace') prompt.text = prompt.text.slice(0, -1)
      else if (str && !key.ctrl && !key.meta) prompt.text += str
      return render()
    }

    const page = bodyHeight()
    if (str === 'q') return quit()
    if (str === 'f') prompt = { kind: 'filter', text: filter?.source ?? '' }
    else if (str === '/') prompt = { kind: 'search', text: search?.source ?? '' }
    else if (key.name === 'escape') search = null
    else if (str === 'n' && search) return jump(visible.length - 2 - offset, -1)
    else if (str === 'N' && search) return jump(visible.length - offset, 1)
    else if (str === 'm' && groupIsOpen()) toggleGroup()
    else if (str === 'm') prompt = { kind: 'group', text: '' }
    else if (str === 'c') return copyLines(visible.map(e => e.plain), filter ? `filtre ${filter}` : 'tout')
    else if (str === 'y') {
      const g = groups.at(-1)
      if (!g) return flash('aucun groupe')
      return copyLines(entries.slice(g.start, g.end).map(e => e.plain), `groupe « ${g.label} »`)
    } else if (key.name === 'up' || str === 'k') offset = clampOffset(offset + 1)
    else if (key.name === 'down' || str === 'j') offset = clampOffset(offset - 1)
    else if (key.name === 'pageup') offset = clampOffset(offset + page)
    else if (key.name === 'pagedown') offset = clampOffset(offset - page)
    else if (str === 'g' || key.name === 'home') offset = clampOffset(Infinity)
    else if (str === 'G' || key.name === 'end') offset = 0
    else return
    render()
  }

  process.on('exit', restore)
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.on('keypress', onKey)
  process.stdout.on('resize', render)
  onLine(add)
  render()
}

const [sub, ...rest] = process.argv.slice(2)
if (sub === 'extract') extract(...rest)
else run(process.argv.slice(2))
