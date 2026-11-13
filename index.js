'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits,
  ChannelType, ButtonStyle, AttachmentBuilder } = require('discord.js');
const game = require('./game');
const ui = require('./ui');
const { Store, createStore } = require('./store');
const { id, need, UserError, match, audit, validate, clearChoices, confirmPick,
  available, dateKey, weekKey, shiftDate, parseTime, competitionDay, clean, imageURL,
  odd, DAYS, PT_DAYS, rangeOptions, rankings, pointsCents, setMatchResult } = game;
const { row, btn, publicCard, pickPreview, myChoice, staffCard, rankCard, listCard,
  programCard, programStaffCard, command } = ui;
async function cacheImage(m, directory) {
  m.imageFile = '';
  if (!m.image) return;
  const url = new URL(m.image);
  // Conserver les images Discord sur le volume.
  if ( !['cdn.discordapp.com', 'media.discordapp.net'].includes( url.hostname)) {
    return;
  }
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(15000), });
  need( response.ok, 'Não foi possível obter a imagem do Discord. Usa um link recente.');
  const type = response.headers.get('content-type')?.split(';')[0];
  const ext = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', }[type];
  need(ext, 'Usa uma imagem PNG, JPG, WEBP ou GIF.');
  need( Number(response.headers.get('content-length') || 0) <=
      8 * 1024 * 1024, 'A imagem excede o limite de 8 MB.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    need( size <= 8 * 1024 * 1024, 'A imagem excede o limite de 8 MB.');
    chunks.push(chunk);
  }
  const folder = path.join(directory, 'images');
  await fs.mkdir(folder, { recursive: true });
  const buffer = Buffer.concat(chunks);
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const imagePath = path.join( folder, `${m.id}-${hash}${ext}`);
  await fs.writeFile(imagePath, buffer, { mode: 0o600 });
  m.imageFile = imagePath;
}
async function run() {
  const env = process.env;
  const guildId = env.DISCORD_GUILD_ID?.trim();
  need( env.DISCORD_TOKEN && /^\d{17,20}$/.test(guildId || ''), 'Define DISCORD_TOKEN e DISCORD_GUILD_ID.');
  const staffId = env.STAFF_CHANNEL_ID?.trim();
  need( /^\d{17,20}$/.test(staffId || ''), 'Define STAFF_CHANNEL_ID com o ID do canal da equipa GOAT Betclic.');
  const admins = new Set( (env.ADMIN_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
  need( admins.size &&
    [...admins].every(x => /^\d{17,20}$/.test(x)), 'Define ADMIN_USER_IDS com os IDs Discord da equipa.');
  const store = createStore(env);
  await store.init();
  await store.change(s => {
    for (const m of Object.values(s.matches)) {
      if (m.status === 'published') {
        m.dirty = true;
        m.lockedOdds ||= {
          home: m.homeOdds, away: m.awayOdds, };
      }
    }
  });
  const client = new Client({
    intents: [GatewayIntentBits.Guilds], });
  const quiet = { parse: [] };
  const privateFlag = MessageFlags.Ephemeral;
  let ticking = false;
  let stopping = false;
  let timer;
  const log = (label, e) => console.error( `${label}: ${e?.code || e?.name || 'Erro'}`);
  const admin = i => {
    need( i.guildId === guildId && admins.has(i.user.id), 'Esta ação está reservada à equipa autorizada.');
  };
  async function channel(cid) {
    const c = await client.channels.fetch(cid);
    need( c &&
      c.guildId === guildId &&
      [ ChannelType.GuildText, ChannelType.GuildAnnouncement,].includes(c.type), 'Canal inacessível.');
    need( c.permissionsFor(client.user)?.has([ PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles,]), 'O bot precisa de ver o canal, ler o histórico e enviar mensagens, ligações e ficheiros.');
    return c;
  }
  async function recover(c, m) {
    if (m.post?.id) {
      try {
        return await c.messages.fetch(m.post.id);
      } catch (e) {
        if (e.code !== 10008) throw e;
        return null;
      }
    }
    if (!m.sendStartedAt) return null;
    let before;
    for (let n = 0; n < 100; n++) {
      const messages = await c.messages.fetch({
        limit: 100,...(before ? { before } : {}), });
      if (!messages.size) return null;
      const found = messages.find( x =>
          x.author.id === client.user.id &&
          ( x.embeds.some( e => e.footer?.text ===
                `GOAT Betclic | Match ${m.id}`) ||
            x.components.some(r =>
              r.components.some( b =>
                  b.customId?.startsWith(`pick:${m.id}:`) ||
                  b.customId === `my:${m.id}`))));
      if (found) return found;
      const last = messages.last();
      if (last.createdTimestamp < m.sendStartedAt - 10000) {
        return null;
      }
      before = last.id;
    }
    throw new Error( 'Não foi possível verificar o histórico antes da publicação.');
  }
  async function syncStaff(m) {
    const c = await channel(staffId);
    const payload = m.type === 'program'
      ? programStaffCard(m)
      : staffCard(m);
    const table = m.type === 'program'
      ? 'programs'
      : 'matches';
    const digest = createHash('sha256').update(JSON.stringify({
      embed: payload.embeds[0].toJSON(),
      components: (payload.components || []).map(component => component.toJSON()),
    })).digest('hex');
    if ( m.staffPost?.channelId === staffId &&
      m.staffDigest === digest) {
      return;
    }
    let previous;
    if (m.staffPost?.channelId === staffId) {
      try {
        previous = await c.messages.fetch(m.staffPost.id);
      } catch (e) {
        if (e.code !== 10008) throw e;
      }
    }
    if (!previous) {
      const since = m.staffSendAt || Date.now();
      if (!m.staffSendAt) {
        await store.change(s => {
          s[table][m.id].staffSendAt = since;
        });
      }
      let before;
      for (let n = 0; n < 100; n++) {
        const items = await c.messages.fetch({
          limit: 100,...(before ? { before } : {}), });
        if (!items.size) break;
        previous = items.find( x =>
            x.author.id === client.user.id &&
            x.embeds.some( e => e.footer?.text ===
                `GOAT Betclic | Ficha ${m.id}`));
        if ( previous ||
          items.last().createdTimestamp < since - 10000) {
          break;
        }
        before = items.last().id;
        if (n === 99) {
          throw new Error( 'O histórico da equipa é demasiado longo para confirmar o envio.');
        }
      }
    }
    const nonce = BigInt( '0x' +
      createHash('sha256').update(`staff:${m.id}`).digest('hex').slice(0, 16)).toString();
    const message = previous
      ? await previous.edit(payload)
      : await c.send({...payload, nonce, enforceNonce: true, });
    await store.change(s => {
      s[table][m.id].staffPost = {
        id: message.id, channelId: staffId, };
      s[table][m.id].staffDigest = digest;
    });
  }
  async function tickPrograms(snapshot) {
    for (const p of Object.values(snapshot.programs || {})) {
      try {
        await syncStaff(p);
        if (p.status === 'deleted') {
          if (p.post?.id) {
            const c = await channel(p.post.channelId);
            try {
              await (await c.messages.fetch(p.post.id)).delete();
            } catch (e) {
              if (e.code !== 10008) throw e;
            }
            await store.change(s => {
              s.programs[p.id].post = null;
            });
          }
          continue;
        }
        if ( p.status === 'scheduled' &&
          p.publishAt > Date.now()) {
          continue;
        }
        const payload = programCard(snapshot, p);
        const digest = createHash('sha256').update( JSON.stringify({content:payload.content, embeds:payload.embeds.map(e => e.toJSON())})).update(p.imageFile || p.image || '').digest('hex');
        if ( p.post?.channelId === p.channelId &&
          p.digest === digest &&
          p.status === 'published') {
          continue;
        }
        if ( p.post &&
          p.post.channelId !== p.channelId) {
          const old = await channel(p.post.channelId);
          try {
            await (await old.messages.fetch(p.post.id)).delete();
          } catch (e) {
            if (e.code !== 10008) throw e;
          }
          await store.change(s => {
            s.programs[p.id].post = null;
            s.programs[p.id].sendStartedAt = null;
          });
          p.post = null;
          p.sendStartedAt = null;
        }
        const c = await channel(p.channelId);
        let previous;
        if (p.post?.id) {
          try {
            previous = await c.messages.fetch(p.post.id);
          } catch (e) {
            if (e.code !== 10008) throw e;
          }
        } else if (p.sendStartedAt) {
          let before;
          for (let n = 0; n < 100; n++) {
            const messages = await c.messages.fetch({
              limit: 100,...(before ? { before } : {}), });
            if (!messages.size) break;
            previous = messages.find( m =>
                m.author.id === client.user.id &&
                m.embeds.some( e => e.footer?.text?.startsWith( `GOAT Betclic | Programa ${p.id} |`)));
            if ( previous ||
              messages.last().createdTimestamp <
                p.sendStartedAt - 10000) {
              break;
            }
            before = messages.last().id;
            if (n === 99) {
              throw new Error( 'O histórico é demasiado longo para confirmar o programa.');
            }
          }
        }
        let message;
        if (previous) {
          message = await previous.edit({...payload, attachments: [], content: payload.content || '', allowedMentions: quiet, });
        } else {
          if (!p.sendStartedAt) {
            p.sendStartedAt = Date.now();
            await store.change(s => {
              s.programs[p.id].sendStartedAt = p.sendStartedAt;
            });
          }
          const nonce = BigInt( '0x' +
            createHash('sha256').update(`program:${p.id}:${p.sendStartedAt}`).digest('hex').slice(0, 16)).toString();
          message = await c.send({...payload, nonce, enforceNonce: true, content:
              p.status === 'scheduled' && p.roleId
                ? `<@&${p.roleId}>` + (payload.content ? '\n' + payload.content : '')
                : payload.content || '', allowedMentions:
              p.status === 'scheduled' && p.roleId
                ? { parse: [], roles: [p.roleId] }
                : quiet, });
        }
        const deleted = await store.change(s => {
          const latest = s.programs[p.id];
          latest.post = {
            id: message.id, channelId: p.channelId, };
          if (latest.status === 'deleted') return true;
          latest.status = 'published';
          if (latest.version === p.version) {
            latest.digest = digest;
          }
          return false;
        });
        if (deleted) {
          await message.delete();
          await store.change(s => {
            s.programs[p.id].post = null;
          });
        }
      } catch (e) {
        log(`Programa ${p.id}`, e);
      }
    }
  }
  async function tick() {
    if (ticking || stopping || !client.isReady()) return;
    ticking = true;
    try {
      const s = await store.read();
      await tickPrograms(s);
      const matches = Object.values(s.matches).sort( (a, b) => a.publishAt - b.publishAt);
      for (const m of matches) {
        try {
          await syncStaff(m);
        } catch (e) {
          log(`Ficha da equipa ${m.id}`, e);
        }
        if (m.status === 'deleted') {
          if (m.post?.id) {
            try {
              const c = await channel(m.post.channelId);
              const msg = await recover(c, m);
              if (msg) await msg.delete();
              await store.change(x => {
                x.matches[m.id].post = null;
              });
            } catch (e) {
              log('Suppression message', e);
            }
          }
          continue;
        }
        const active =
          !m.closedAt &&
          m.result === null &&
          Date.now() < m.closeAt;
        const publishNow =
          m.status === 'scheduled' &&
          m.publishAt <= Date.now();
        const updateNow =
          m.status === 'published' &&
          (m.dirty || m.lastOpen !== active);
        if (!publishNow && !updateNow) continue;
        try {
          let target = m;
          if ( m.post &&
            m.post.channelId !== m.channelId) {
            const oldChannel = await channel(m.post.channelId);
            const old = await recover(oldChannel, m);
            if (old) await old.delete();
            await store.change(x => {
              x.matches[m.id].post = null;
              x.matches[m.id].sendStartedAt = null;
            });
            target = {...m, post: null, sendStartedAt: null, };
          }
          if (!m.lockedOdds) {
            const locked = await store.change(x => {
              const current = x.matches[m.id];
              current.lockedOdds ||= {
                home: current.homeOdds, away: current.awayOdds, };
              return structuredClone(current.lockedOdds);
            });
            m.lockedOdds = locked;
          }
          const c = await channel(m.channelId);
          const old = await recover(c, target);
          const payload = publicCard(m);
          let sent;
          if (old) {
            sent = await old.edit({...payload, attachments: [], content: '', allowedMentions: quiet, });
          } else {
            if (!target.sendStartedAt) {
              target.sendStartedAt = Date.now();
              await store.change(x => {
                x.matches[m.id].sendStartedAt =
                  target.sendStartedAt;
              });
            }
            const nonce = BigInt( '0x' +
              createHash('sha256').update(`${m.id}:${target.sendStartedAt}`).digest('hex').slice(0, 16)).toString();
            sent = await c.send({...payload, nonce, enforceNonce: true, content:
                m.status === 'scheduled' && m.roleId
                  ? `<@&${m.roleId}>`
                  : '', allowedMentions:
                m.status === 'scheduled' && m.roleId
                  ? { parse: [], roles: [m.roleId] }
                  : quiet, });
          }
          const deleted = await store.change(x => {
            const latest = x.matches[m.id];
            latest.post = {
              id: sent.id, channelId: m.channelId, };
            if (latest.status === 'deleted') return true;
            latest.status = 'published';
            latest.lastOpen = active;
            if (latest.version === m.version) {
              latest.dirty = false;
            }
            return false;
          });
          if (deleted) {
            await sent.delete();
            await store.change(x => {
              x.matches[m.id].post = null;
            });
          }
        } catch (e) {
          log(`Publication ${m.id}`, e);
        }
      }
    } catch (e) {
      log('Agendamento', e);
    } finally {
      ticking = false;
    }
  }
  async function pending(i, action) {
    const token = id();
    await store.change(s => {
      s.pending[token] = {...action, uid: i.user.id, expires: Date.now() + 15 * 60000, };
    });
    let text;
    if (action.kind === 'program-delete') {
      text =
        '⚠️ Eliminar este programa e o anúncio? ' +
        'Os jogos e os prognósticos serão mantidos.';
    } else if (action.kind === 'delete') {
      text =
        '⚠️ Eliminar este jogo e a respetiva publicação? ' +
        'Os pontos serão retirados da classificação. ' +
        'Será arquivada uma cópia.';
    } else {
      text =
        '⚠️ Trocar as equipas ou a jornada ' +
        'apaga os prognósticos e o boost deste jogo. Confirmas?';
    }
    return i.editReply({
      content: text, embeds: [], components: [ row( btn( `admin-confirm:${token}`, 'Confirmar', ButtonStyle.Danger), btn( `admin-cancel:${token}`, 'Cancelar', ButtonStyle.Secondary)),], allowedMentions: quiet, });
  }
  async function slash(i) {
    need( i.guildId === guildId, 'Usa este comando no servidor configurado.');
    const sub = i.options.getSubcommand();
    admin(i);
    await i.deferReply({ flags: privateFlag });
    if (sub === 'schedule-week' || sub === 'edit-week') {
      const o = i.options, existingId = o.getString('id');
      const state = await store.read();
      const before = existingId ? state.programs[existingId] : null;
      need(!existingId || (before && before.status !== 'deleted'), 'Programa não encontrado. O ID está no canal da equipa.');
      need(sub !== 'edit-week' || before, 'Indica o ID do programa a editar.');
      const p = before ? structuredClone(before) : {
        id:id(), type:'program', status:'scheduled', version:1, post:null, createdAt:Date.now(), description:'', image:'', imageFile:'', blocks:Object.fromEntries(DAYS.map(day => [day, ''])), };
      if (o.getString('inicio')) p.start = weekKey(dateKey(o.getString('inicio')));
      need(p.start, 'Indica a data de início.');
      p.end = shiftDate(p.start,6);
      if (o.getString('fim')) need(dateKey(o.getString('fim')) === p.end, 'O programa vai de segunda-feira a domingo. Deixa o fim em branco para calcular o domingo.');
      if (o.getString('publicacao')) p.publishAt = parseTime(o.getString('publicacao'));
      if (o.getChannel('canal')) p.channelId = o.getChannel('canal').id;
      p.title = clean(o.getString('titulo') ?? before?.title ?? 'GOAT BETCLIC 🏀 👑', 200, 'Título');
      if (o.getString('texto') !== null) p.description = o.getString('texto');
      if (o.getBoolean('texto-predefinido')) p.description = '';
      p.blocks ||= Object.fromEntries(DAYS.map(day => [day, '']));
      for (const day of DAYS) if (o.getString(PT_DAYS[day]) !== null) p.blocks[day] = o.getString(PT_DAYS[day]);
      p.image = imageURL(o.getString('imagem') ?? before?.image ?? '');
      if (o.getBoolean('remover-imagem')) { p.image = ''; p.imageFile = ''; }
      p.roleId = o.getRole('notificacao')?.id ?? before?.roleId ?? null;
      if (o.getBoolean('remover-notificacao')) p.roleId = null;
      p.rulesChannelId = o.getChannel('regulamento')?.id ?? before?.rulesChannelId ?? null;
      need(p.status === 'published' || p.publishAt > Date.now(), 'Escolhe uma data de publicação futura.');
      await channel(p.channelId);
      if (!before || p.image !== before.image) await cacheImage(p, store.directory);
      programCard(state,p).embeds[0].toJSON();
      await store.change(s => {
        if (before) need(s.programs[p.id]?.version === before.version, 'O programa foi alterado. Tenta novamente.');
        p.version = (before?.version || 0) + 1;
        p.digest = null;
        s.programs[p.id] = p;
        audit(s, i.user.id, sub, p.id);
      });
      void tick();
      return i.editReply({
        content:`✅ Programa ${before ? 'alterado' : 'agendado'}. ID : \`${p.id}\`.\nFicha da equipa : <#${staffId}>.\nO programa é independente dos jogos. /goat create-match mantém o anúncio como está.`, allowedMentions: quiet, });
    }
    if (sub === 'delete-program') {
      const s = await store.read();
      const p = s.programs[i.options.getString('id')];
      need( p && p.status !== 'deleted', 'Programa não encontrado.');
      return pending(i, {
        kind: 'program-delete', mid: p.id, version: p.version, });
    }
    if (sub === 'create-match' || sub === 'edit-match') {
      const o = i.options;
      const editing = sub === 'edit-match';
      const before = editing
        ? match(await store.read(), o.getString('id'))
        : null;
      const m = before
        ? structuredClone(before)
        : {
            id: id(), status: 'scheduled', result: null, revision: 1, version: 1, post: null, dirty: true, createdAt: Date.now(), description: '', image: '', imageFile: '', roleId: null, };
      const strings = {
        titulo: 'title', 'equipa-a': 'home', 'equipa-b': 'away', texto: 'description', jornada: 'date', };
      for (const [key, prop] of Object.entries(strings)) {
        const v = o.getString(key);
        if (v !== null) m[prop] = v;
      }
      for (const [key, prop] of [ ['odd-a', 'homeOdds'], ['odd-b', 'awayOdds'],]) {
        const v = o.getNumber(key);
        if (v !== null) m[prop] = v;
      }
      if (o.getString('publicacao')) {
        m.publishAt = parseTime(o.getString('publicacao'));
      }
      if (o.getString('fecho')) {
        m.closeAt = parseTime(o.getString('fecho'));
      }
      if (o.getChannel('canal')) {
        m.channelId = o.getChannel('canal').id;
      }
      if (o.getRole('notificacao')) {
        m.roleId = o.getRole('notificacao').id;
      }
      if (editing && o.getBoolean('remover-notificacao')) {
        m.roleId = null;
      }
      if (!m.date) m.date = competitionDay(m.publishAt);
      if (!m.title) m.title = `${m.home} VS ${m.away}`;
      // Ne pas rouvrir un match déjà clôturé.
      if ( before?.status === 'published' &&
        Date.now() >= before.closeAt) {
        m.closeAt = Math.min(m.closeAt, before.closeAt);
      }
      validate(m);
      await channel(m.channelId);
      if (before?.lockedOdds) {
        need( m.homeOdds === before.homeOdds &&
          m.awayOdds === before.awayOdds, 'As odds ficam fixas na publicação. Para substituir o jogo, elimina-o e cria outro.');
      }
      if (!editing) {
        need( m.publishAt > Date.now(), 'Escolhe uma data de publicação futura.');
      }
      if (!before || before.status !== 'published') {
        need( m.closeAt > Date.now(), 'O fecho tem de ocorrer numa data futura.');
      }
      const sensitive =
        before &&
        ( before.home !== m.home ||
          before.away !== m.away ||
          before.date !== m.date);
      const state = await store.read();
      const hasChoices =
        Object.keys(state.votes[m.id] || {}).length > 0;
      if (sensitive && hasChoices) {
        need( o.getBoolean('apagar-escolhas'), 'Já existem prognósticos. Usa apagar-escolhas:true para alterar as equipas ou a jornada, com confirmação.');
        return pending(i, {
          kind: 'edit', mid: m.id, version: before.version, data: m, });
      }
      await store.change(s => {
        if (before) {
          const current = match(s, m.id);
          need( current.version === before.version, 'O jogo foi alterado. Volta a iniciar a edição.');
          if (sensitive) clearChoices(s, current);
          need( !current.lockedOdds ||
            ( m.homeOdds === current.homeOdds &&
              m.awayOdds === current.awayOdds), 'As odds já ficaram fixas na publicação.');
          m.lockedOdds = current.lockedOdds;
          m.revision = current.revision;
          m.result = current.result;
          m.status = current.status;
          m.post = current.post;
          m.sendStartedAt = current.sendStartedAt;
          m.version = current.version + 1;
        }
        m.dirty = true;
        s.matches[m.id] = m;
        audit(s, i.user.id, sub, m.id);
      });
      void tick();
      return i.editReply({
        content:
          `✅ ${editing ? 'Jogo alterado' : 'Jogo criado e agendado'}. ` +
          `A ficha completa está disponível em <#${staffId}>.`, allowedMentions: quiet, });
    }
    const s = await store.read();
    if (sub === 'delete-match') {
      const m = match(s, i.options.getString('id'));
      return pending(i, {
        kind: 'delete', mid: m.id, version: m.version, });
    }
    if (sub === 'close-match') {
      const mid = i.options.getString('id');
      await store.change(x => {
        const m = match(x, mid);
        need( !m.closedAt, 'Os prognósticos já foram encerrados manualmente.');
        m.closedAt = Date.now();
        m.dirty = true;
        m.version++;
        audit(x, i.user.id, 'close-match', mid);
      });
      void tick();
      return i.editReply( '🔒 Prognósticos encerrados de imediato. ' +
        'Os prognósticos confirmados e os pontos foram mantidos. ' +
        'A ficha da equipa será atualizada.');
    }
    if (sub === 'set-result') {
      const mid = i.options.getString('id');
      const result = i.options.getString('vencedor');
      await store.change(x => setMatchResult(x, mid, result, i.user.id));
      void tick();
      return i.editReply( '✅ Resultado registado. Os pontos são recalculados, ' +
        'sem publicação automática da classificação.');
    }
    if (sub === 'leaderboard') {
      return i.editReply(rankCard(s, rangeOptions(i.options)));
    }
    if (sub === 'list' || sub === 'day') {
      const date = sub === 'day'
        ? dateKey(i.options.getString('data'))
        : null;
      return i.editReply(listCard(s, date));
    }
    if (sub === 'diagnostic') {
      const all = Object.values(s.matches).filter( m => m.status !== 'deleted');
      return i.editReply( `✅ Cópia de segurança: ${store.filename}\n` +
        `📅 ${all.filter(m => m.status === 'scheduled').length} jogos agendados\n` +
        `📣 ${all.filter(m => m.status === 'published').length} jogos publicados\n` +
        `⏳ ${all.filter(m => m.result === null && m.closeAt < Date.now()).length} resultados por registar\n` +
        '🏆 Classificaçãos uniquement sur commande\n' +
        '🕰 Hora de Lisboa\n' +
        `📦 ${s.archives.length} ficheiros arquivados`);
    }
    if (sub === 'export') {
      const range = rangeOptions(i.options);
      const values = rankings(s, range);
      const csv = v => `"${String(v ?? '').replaceAll('"', '""').replace(/^[=+\-@]/, "'$&")}"`;
      const rows = [[ 'date', 'match_id', 'discord_id', 'pseudo', 'equipa_a', 'equipa_b', 'escolha', 'boost', 'resultado', 'pontos',]];
      for (const m of Object.values(s.matches)) {
        if ( m.status === 'deleted' ||
          (range.start && m.date < range.start) ||
          (range.end && m.date > range.end)) {
          continue;
        }
        for (const [uid, v] of Object.entries(s.votes[m.id] || {})) {
          if (v.revision !== m.revision) continue;
          const boost = s.boosts[m.date]?.[uid] === m.id;
          rows.push([ m.date, m.id, uid, v.name, m.home, m.away, v.side === 'home' ? m.home : m.away, boost ? 'sim' : 'não', m.result || 'pendente', pointsCents(s, m, uid, v) / 100,]);
        }
      }
      const standings = [ [ 'posicao', 'discord_id', 'pseudo', 'pontos', 'prognosticos_certos', 'boosts_vencedores',],...values.map(v => [ v.rank, v.uid, v.name, v.points, v.wins, v.boostedWins,]),];
      const file = (data, name) => new AttachmentBuilder( Buffer.from( '\uFEFF' +
          data.map(r => r.map(csv).join(';')).join('\r\n')), { name });
      return i.editReply({
        content: `📁 Export ${range.label}`, files: [ file(rows, 'prognosticos.csv'), file(standings, 'classificacao.csv'),], });
    }
  }
  async function buttons(i) {
    need(i.guildId === guildId, 'Servidor inválido.');
    const [action, mid, side, rev] = i.customId.split(':');
    if (i.message.flags.has(privateFlag)) {
      await i.deferUpdate();
    } else {
      await i.deferReply({ flags: privateFlag });
    }
    if (action === 'staff-result') {
      admin(i);
      need(i.channelId === staffId, 'Usa os botões no canal da equipa.');
      await store.change(x => {
        const m = match(x, mid);
        need(m.staffPost?.id === i.message.id, 'Usa a ficha atual do jogo.');
        setMatchResult(x, mid, side, i.user.id, Number(rev));
      });
      void tick();
      return i.editReply('✅ Resultado registado. Para corrigir, usa /goat set-result com o ID da ficha.');
    }
    if (action === 'program-page') {
      const s = await store.read();
      const p = s.programs[mid];
      need( p && p.status === 'published', 'Programa indisponível.');
      return i.editReply(programCard(s, p, side));
    }
    if (action.startsWith('admin-')) {
      admin(i);
      const token = mid;
      await store.change(s => {
        const p = s.pending[token];
        need( p &&
          p.uid === i.user.id &&
          p.expires > Date.now(), 'A confirmação expirou. Volta a usar o comando.');
        if (action === 'admin-confirm') {
          if (p.kind === 'program-delete') {
            const program = s.programs[p.mid];
            need( program && program.version === p.version, 'O programa foi alterado. Tenta novamente.');
            s.archives.push({
              action: 'suppression-programme', at: Date.now(), program: structuredClone(program), });
            program.status = 'deleted';
            program.version++;
            audit(s, i.user.id, p.kind, p.mid);
            delete s.pending[token];
            return;
          }
          const m = match(s, p.mid);
          need( m.version === p.version, 'O jogo foi alterado. Volta a usar o comando.');
          if (p.kind === 'delete') {
            s.archives.push({
              action: 'suppression', at: Date.now(), match: structuredClone(m), votes: structuredClone(s.votes[m.id] || {}), });
            clearChoices(s, m);
            m.status = 'deleted';
            m.version++;
          } else {
            clearChoices(s, m);
            Object.assign(m, p.data, {
              revision: m.revision, version: m.version + 1, result: null, dirty: true, });
          }
          audit(s, i.user.id, p.kind, p.mid);
        }
        delete s.pending[token];
      });
      void tick();
      return i.editReply({
        content: action === 'admin-confirm'
          ? '✅ Alteração confirmada.'
          : 'Alteração cancelada.', embeds: [], components: [], });
    }
    if (action === 'rank') {
      admin(i);
      const [, start, end, page] = i.customId.split(':');
      const range = start === 'all'
        ? { label: 'geral' }
        : {
            start, end, label: `du ${start} au ${end}`, };
      return i.editReply( rankCard(await store.read(), range, page));
    }
    if (action === 'list') {
      admin(i);
      return i.editReply( listCard( await store.read(), mid === 'all' ? null : mid, side));
    }
    // Compatibilité avec les anciens boutons.
    if (['play', 'summary'].includes(action)) {
      const s = await store.read();
      const legacy = s.legacyDays?.[mid]?.[0];
      need( legacy, 'Usa os botões da publicação atualizada do jogo.');
      const m = match(s, legacy);
      return i.editReply({...publicCard(m), content: 'Escolhe uma equipa para este jogo.', });
    }
    if (action === 'my') {
      const s = await store.read();
      return i.editReply( myChoice(s, match(s, mid), i.user.id));
    }
    if (['pick', 'boost', 'validate'].includes(action)) {
      const current = await store.read();
      if (current.votes[mid]?.[i.user.id]) {
        if (action === 'pick') {
          return i.editReply({
            content:
              'Já participaste neste jogo.\n\n' +
              'Para consultares o prognóstico, carrega em **A minha escolha**.', embeds: [], components: [], allowedMentions: quiet, });
        }
        return i.editReply( myChoice(current, match(current, mid), i.user.id));
      }
    }
    if (action === 'cancel') {
      await store.change(s => {
        delete s.drafts[mid]?.[i.user.id];
      });
      return i.editReply({
        content:
          'Escolha cancelada. Podes escolher uma equipa na publicação do jogo.', embeds: [], components: [], });
    }
    if (action === 'pick' || action === 'boost') {
      const s = await store.change(x => {
        const m = match(x, mid);
        need(available(m), 'Este jogo já não aceita prognósticos.');
        x.drafts[mid] ||= {};
        if (action === 'pick') {
          need( m.revision === Number(rev), 'O jogo foi alterado. Usa a publicação atualizada.');
          need( ['home', 'away'].includes(side), 'Escolha inválida.');
          x.drafts[mid][i.user.id] = {
            side, revision: m.revision, boost:
              x.drafts[mid][i.user.id]?.boost ??
              (x.boosts[m.date]?.[i.user.id] === mid), version:
              (x.drafts[mid][i.user.id]?.version || 0) + 1, };
        } else {
          const d = x.drafts[mid][i.user.id];
          need(d, 'Escolhe uma equipa antes de ativares o boost.');
          need( !x.boosts[m.date]?.[i.user.id] ||
            x.boosts[m.date][i.user.id] === mid, 'Já usaste o boost noutro jogo.');
          d.boost = !d.boost;
          d.version++;
        }
        return x;
      });
      return i.editReply( pickPreview(s, match(s, mid), i.user.id));
    }
    if (action === 'validate') {
      await store.change(s => {
        const m = match(s, mid);
        const d = s.drafts[mid]?.[i.user.id];
        need( d &&
          d.revision === Number(side) &&
          d.version === Number(rev), 'A tua escolha mudou. Revê o resumo antes de confirmares.');
        confirmPick( s, mid, i.user.id, d.side, d.boost, d.revision, i.member?.displayName ||
          i.user.globalName ||
          i.user.username);
      });
      const s = await store.read();
      return i.editReply( myChoice(s, match(s, mid), i.user.id));
    }
  }
  client.on(Events.InteractionCreate, async i => {
    if (stopping) return;
    try {
      if ( i.isChatInputCommand() &&
        i.commandName === 'goat') {
        await slash(i);
      } else if ( i.isButton() &&
        /^(staff-result|program-page|pick|boost|validate|cancel|my|rank|list|admin-confirm|admin-cancel|play|summary):/.test( i.customId)) {
        await buttons(i);
      }
    } catch (e) {
      if (!(e instanceof UserError)) log('Interaction', e);
      const payload = {
        content: e instanceof UserError
          ? `⚠️ ${e.message}`
          : 'Ocorreu um erro. Os dados já guardados foram mantidos.', flags: privateFlag, allowedMentions: quiet, };
      try {
        if (i.deferred || i.replied) {
          await i.followUp(payload);
        } else {
          await i.reply(payload);
        }
      } catch (err) {
        log('Erro na resposta', err);
      }
    }
  });
  client.on(Events.Error, e => log('Discord', e));
  client.once(Events.ClientReady, async () => {
    try {
      const guild = await client.guilds.fetch(guildId);
      await channel(staffId);
      const previous = await guild.commands.fetch();
      for (const c of previous.values()) {
        if (c.name === 'goat-admin') {
          await guild.commands.delete(c.id);
        }
      }
      const globals = await client.application.commands.fetch();
      for (const c of globals.values()) {
        if (['goat', 'goat-admin'].includes(c.name)) {
          await client.application.commands.delete(c.id);
        }
      }
      await guild.commands.create(command.toJSON());
      console.log( 'GOAT Betclic pronto. Comandos registados. Dados guardados no volume.');
      await tick();
      timer = setInterval(() => void tick(), 15000);
    } catch (e) {
      log('Inicialização', e);
      void stop(1);
    }
  });
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    client.destroy();
    await store.close().catch(() => {});
    process.exit(code);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => void stop());
  }
  process.once('uncaughtException', e => {
    log('Erro fatal', e);
    void stop(1);
  });
  process.once('unhandledRejection', e => {
    log('Erro fatal', e);
    void stop(1);
  });
  await client.login(env.DISCORD_TOKEN);
}
if (require.main === module) {
  run().catch(e => {
    console.error( `Arranque: ${
        e instanceof UserError
          ? e.message
          : e.code || e.name
      }`);
    process.exitCode = 1;
  });
} else {
  module.exports = { ...game, ...ui, Store };
}
