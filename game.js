'use strict';
const { escapeMarkdown } = require('discord.js');
const { randomUUID } = require('node:crypto');
const ZONE = 'Europe/Lisbon';
const id = () => randomUUID().replaceAll('-', '').slice(0, 16);
class UserError extends Error {}
const need = (condition, text) => {
  if (!condition) throw new UserError(text);
};
const lisbonParts = ms => Object.fromEntries( new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', }).formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
function lisbonDate(ms) {
  const p = lisbonParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}
function lisbonInput(ms) {
  const p = lisbonParts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function formatTime(ms) {
  const p = lisbonParts(ms);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
function dateKey(value) {
  need( /^\d{4}-\d{2}-\d{2}$/.test(value || ''), 'Data esperada : AAAA-MM-DD.');
  const ms = Date.parse(`${value}T12:00:00Z`);
  need( Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 10) === value, 'Data inválida.');
  return value;
}
function shiftDate(value, days) {
  const ms =
    Date.parse(`${dateKey(value)}T12:00:00Z`) +
    days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
function weekKey(value) {
  const date = dateKey(value);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return shiftDate(date, -(weekday === 0 ? 6 : weekday - 1));
}
function parseTime(value) {
  let text = value.trim();
  if (/^\d{2}:\d{2} \d{4}-\d{2}-\d{2}$/.test(text)) {
    text = text.slice(6) + ' ' + text.slice(0, 5);
  }
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    dateKey(text.slice(0, 10));
    const ms = Date.parse(text);
    need(Number.isFinite(ms), 'Data/hora ISO inválida.');
    return ms;
  }
  need( /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/.test(text), 'Data/hora esperada : AAAA-MM-DD HH:mm, hora de Lisboa.');
  dateKey(text.slice(0, 10));
  const utc = Date.parse(text.replace(' ', 'T') + ':00Z');
  const candidates = [];
  for (let offset = -180; offset <= 180; offset += 30) {
    const ms = utc + offset * 60000;
    if (lisbonInput(ms) === text) candidates.push(ms);
  }
  need( candidates.length > 0, 'Esta hora não existe devido à mudança da hora.');
  need( candidates.length === 1, 'Hora ambígua. Usa o formato ISO com fuso horário, por exemplo 2026-10-25T01:30:00+01:00.');
  return candidates[0];
}
function imageURL(value) {
  const url = value?.trim() || '';
  if (!url) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError('Link da imagem inválido.');
  }
  need( parsed.protocol === 'https:' &&
    !parsed.username &&
    !parsed.password, 'Usa um link HTTPS público para a imagem.');
  need(url.length <= 1000, 'O link da imagem é demasiado longo.');
  return url;
}
function odd(value) {
  const n = Number(String(value).replace(',', '.'));
  need( Number.isFinite(n) &&
    n >= 1 &&
    n <= 10000 &&
    Math.abs(n * 100 - Math.round(n * 100)) < 0.000001, 'A odd tem de estar entre 1 e 10 000, com até duas casas decimais.');
  return n;
}
function clean(value, max, name) {
  const s = String(value || '').trim().replace(/[\u2013\u2014]/g, '-');
  need( s.length > 0 && s.length <= max, `${name} : entre 1 e ${max} caracteres.`);
  return s;
}
const safe = text =>
  escapeMarkdown(String(text)).replaceAll('@', '@\u200b');
const available = (m, now = Date.now()) =>
  m.status === 'published' &&
  !m.closedAt &&
  m.result === null &&
  now < m.closeAt;
const match = (s, mid) => {
  const m = s.matches[mid];
  need( m && m.status !== 'deleted', 'Jogo não encontrado. Usa /goat list para encontrar o ID.');
  return m;
};
function initialState() {
  return {
    schema: 2, programs: {}, matches: {}, votes: {}, drafts: {}, boosts: {}, pending: {}, archives: [], audit: [], };
}
function migrate(old) {
  if ( old.schema === 2 &&
    old.matches &&
    old.votes &&
    old.boosts) {
    old.programs ||= {};
    for (const p of Object.values(old.programs)) {
      p.type = 'program';
      freezeProgram(old, p);
    }
    return old;
  }
  need( old.schema === 1 && old.days, 'Não foi possível ler a cópia de segurança. Mantém o ficheiro.');
  const s = initialState();
  s.archives.push({
    action: 'migration', at: Date.now(), data: old, });
  s.legacyDays = {};
  for (const d of Object.values(old.days)) {
    s.legacyDays[d.id] = [];
    for (const [index, x] of d.matches.entries()) {
      s.matches[x.id] = {
        id: x.id, title: `${x.home} / ${x.away}`, home: x.home, away: x.away, homeOdds: x.homeOdds, awayOdds: x.awayOdds, date: d.date, publishAt: d.publishAt, closeAt: x.lockAt, channelId: d.post?.channelId || old.config.channelId, description: d.description || '', image: x.image || d.image || '', imageFile: '', roleId: null, status: d.status === 'draft' ? 'draft' : d.status, result: x.result, revision: x.revision, version: 1, dirty: false, post: index === 0 ? d.post : null, createdAt: d.createdAt, };
      s.legacyDays[d.id].push(x.id);
      s.votes[x.id] = {};
      for (const [uid, v] of Object.entries(d.votes)) {
        if (v.picks[x.id]) {
          s.votes[x.id][uid] = {...v.picks[x.id], name: v.name || uid, };
        }
        if (v.boost === x.id) {
          s.boosts[d.date] ||= {};
          s.boosts[d.date][uid] = x.id;
        }
      }
    }
  }
  return s;
}
function audit(s, uid, action, mid) {
  s.audit.push({ at: Date.now(), uid, action, mid });
  if (s.audit.length > 2000) {
    s.audit.splice(0, s.audit.length - 2000);
  }
}
function validate(m) {
  m.title = clean(m.title, 200, 'Titre');
  m.home = clean(m.home, 70, 'Equipa A');
  m.away = clean(m.away, 70, 'Equipa B');
  need( m.home.toLowerCase() !== m.away.toLowerCase(), 'As duas equipas têm de ser diferentes.');
  m.homeOdds = odd(m.homeOdds);
  m.awayOdds = odd(m.awayOdds);
  m.date = dateKey(m.date);
  m.image = imageURL(m.image);
  m.description = String(m.description || '').replace(/[\u2013\u2014]/g, '-').slice(0, 1500);
  need( m.publishAt < m.closeAt, 'A publicação tem de ocorrer antes do fecho.');
  need( /^\d{17,20}$/.test(m.channelId || ''), 'Canal inválido.');
}
function clearChoices(s, m) {
  s.archives.push({
    action: 'invalidation', at: Date.now(), match: structuredClone(m), votes: structuredClone(s.votes[m.id] || {}), });
  s.votes[m.id] = {};
  s.drafts[m.id] = {};
  for (const perDay of Object.values(s.boosts)) {
    for (const [uid, mid] of Object.entries(perDay)) {
      if (mid === m.id) delete perDay[uid];
    }
  }
  m.revision++;
  m.result = null;
}
function confirmPick(
  s,
  mid,
  uid,
  side,
  boosted,
  revision,
  name,
  now = Date.now()
) {
  const m = match(s, mid);

  need(
    !s.votes[mid]?.[uid],
    'O teu prognóstico já está confirmado e não pode ser alterado.'
  );

  need(available(m, now), 'Este jogo já não aceita prognósticos.');

  need(
    revision === m.revision,
    'O jogo foi alterado. Volta a escolher na publicação.'
  );

  need(['home', 'away'].includes(side), 'Escolha inválida.');

  s.boosts[m.date] ||= {};

  const old = s.boosts[m.date][uid];

  need(
    !boosted || !old || old === mid,
    'Já usaste o boost desta jornada noutro jogo.'
  );

  s.votes[mid] ||= {};

  s.votes[mid][uid] = {
    side,
    revision,
    name,
    odds: chosenOdds(m, side),
    at: now,
  };

  if (boosted) {
    s.boosts[m.date][uid] = mid;
  } else if (old === mid) {
    delete s.boosts[m.date][uid];
  }

  delete s.drafts[mid]?.[uid];
}

function chosenOdds(m, side) {
  return odd(
    m.lockedOdds?.[side] ??
    (side === 'home' ? m.homeOdds : m.awayOdds)
  );
}

function pointsCents(s, m, uid, v) {
  if (
    v.revision !== m.revision ||
    m.result !== v.side
  ) {
    return 0;
  }

  return Math.round(
    odd(v.odds ?? chosenOdds(m, v.side)) * 100
  ) * (s.boosts[m.date]?.[uid] === m.id ? 2 : 1);
}

function rankings(s, range) {
  const users = new Map();

  for (const m of Object.values(s.matches)) {
    if (
      m.status === 'deleted' ||
      (range.start && m.date < range.start) ||
      (range.end && m.date > range.end)
    ) {
      continue;
    }

    for (const [uid, v] of Object.entries(s.votes[m.id] || {})) {
      if (v.revision !== m.revision) continue;

      const r = users.get(uid) || {
        uid,
        name: v.name || uid,
        pointsCents: 0,
        wins: 0,
        boostedWins: 0,
        picks: 0,
      };

      r.picks++;
      r.name = v.name || r.name;
      r.pointsCents += pointsCents(s, m, uid, v);

      if (m.result === v.side) {
        r.wins++;

        if (s.boosts[m.date]?.[uid] === m.id) {
          r.boostedWins++;
        }
      }

      users.set(uid, r);
    }
  }

  const result = [...users.values()].sort(
    (a, b) =>
      b.pointsCents - a.pointsCents ||
      b.wins - a.wins ||
      b.boostedWins - a.boostedWins ||
      a.uid.localeCompare(b.uid)
  );

  result.forEach((r, n) => {
    r.points = r.pointsCents / 100;

    const prev = result[n - 1];

    r.rank =
      prev &&
      r.pointsCents === prev.pointsCents &&
      r.wins === prev.wins &&
      r.boostedWins === prev.boostedWins
        ? prev.rank
        : n + 1;
  });

  return result;
}

// Une journée GOAT va de midi à midi, hora de Lisboa.
function competitionDay(ms = Date.now()) {
  const date = lisbonDate(ms);
  return Number(lisbonParts(ms).hour) < 12 ? shiftDate(date, -1) : date;
}
function rangeOptions(options, now = Date.now()) {
  const period = options.getString('periodo') || 'semaine';
  const start = options.getString('inicio');
  const end = options.getString('fim');
  if (start || end) {
    need( start && end, 'Para um período personalizado, indica o início e o fim.');
    dateKey(start);
    dateKey(end);
    need( start <= end, 'A data de início tem de ser anterior à data de fim.');
    return {
      start, end, label: `du ${start} au ${end}`, };
  }
  if (period === 'general') return { label: 'geral' };
  const monday = weekKey(competitionDay(now));
  return {
    start: monday, end: shiftDate(monday, 6), label: `de ${monday} às 12h até ${shiftDate(monday, 7)} às 12h`, };
}
const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const PT_DAYS = Object.fromEntries(DAYS.map((day, n) => [day, ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'][n]]));
function programMatches(s, p) {
  const start = weekKey(p.start);
  return Object.values(s.matches).filter(m => m.status !== 'deleted' && m.channelId === p.channelId && m.date >= start && m.date <= shiftDate(start, 6)).sort((a,b) => a.date.localeCompare(b.date) || a.closeAt - b.closeAt);
}
function freezeProgram(s, p) {
  if (p.blocks) return;
  p.blocks = Object.fromEntries(DAYS.map(day => [day, '']));
  const start = weekKey(p.start);
  for (let n = 0; n < 7; n++) {
    p.blocks[DAYS[n]] = programMatches(s,p).filter(m => m.date === shiftDate(start,n)).map(m => `• ${safe(m.home)} - ${safe(m.away)}`).join('\n');
  }
}

function setMatchResult(state, matchId, outcome, userId, expectedVersion) {
  need(['home', 'away', 'void', 'pending'].includes(outcome), 'Resultado inválido.');
  const m = match(state, matchId);
  if (expectedVersion !== undefined) {
    need(m.result === null, 'Já existe um resultado. Para corrigir, usa /goat set-result.');
    need(m.version === expectedVersion, 'A ficha foi atualizada. Usa os botões atuais.');
  }
  need(outcome === 'pending' || outcome === 'void' || Date.now() >= m.closeAt,
    'O jogo ainda não começou.');
  m.result = outcome === 'pending' ? null : outcome;
  m.dirty = true;
  m.version++;
  audit(state, userId, 'set-result', matchId);
}

module.exports = { ZONE, id, need, UserError, lisbonDate, formatTime, dateKey, shiftDate, weekKey, parseTime, imageURL, odd, clean, safe, available, match, initialState, migrate, audit, validate, clearChoices, confirmPick, chosenOdds, pointsCents, rankings, competitionDay, rangeOptions, DAYS, PT_DAYS, programMatches, freezeProgram, setMatchResult };
