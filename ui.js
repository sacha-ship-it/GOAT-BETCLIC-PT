'use strict';
const path = require('node:path');
const { PermissionFlagsBits, SlashCommandBuilder, ChannelType, EmbedBuilder,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder } = require('discord.js');
const { ZONE, safe, need, available, chosenOdds, formatTime, rankings, DAYS,
  PT_DAYS, weekKey, shiftDate } = require('./game');
const RED = /^#[a-f\d]{6}$/i.test(process.env.GOAT_COLOR || '')
  ? process.env.GOAT_COLOR
  : '#E31B23';
const row = (...items) =>
  new ActionRowBuilder().addComponents(items);
const btn = ( key, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(key).setLabel(label.slice(0, 80)).setStyle(style).setDisabled(disabled);
const fmtOdd = value => value.toLocaleString('pt-PT', {
  minimumFractionDigits: 2, maximumFractionDigits: 2, });
function baseEmbed(title) {
  return new EmbedBuilder().setColor(RED).setTitle(title).setFooter({ text: 'GOAT Betclic' });
}
function media(m, e) {
  if (m.imageFile) {
    const name = `goat-${m.id}${path.extname(m.imageFile)}`;
    e.setImage(`attachment://${name}`);
    return {
      files: [ new AttachmentBuilder(m.imageFile, { name }),], };
  }
  if (m.image) e.setImage(m.image);
  return {};
}
function publicCard(m) {
  const active =
    !m.closedAt &&
    m.result === null &&
    Date.now() < m.closeAt;
  const e = baseEmbed(m.title).setDescription([ m.description || 'Quem vai ganhar este jogo? 🏀', '', `⚡ **${safe(m.home)}**  ·  *${fmtOdd(chosenOdds(m, 'home'))}*`, '', '**VS**', '', `🔥 **${safe(m.away)}**  ·  *${fmtOdd(chosenOdds(m, 'away'))}*`, '', '👇 **Escolhe a tua equipa** e confirma o prognóstico.', '', `🕒 **Fim dos prognósticos :** ${formatTime(m.closeAt)} (hora de Lisboa)`, '', '🎯 **Prognóstico certo = pontos iguais à odd.**', '⚡ **Um boost x2 por jornada.** Depois de confirmada, a tua escolha é definitiva.', m.result === 'void'
      ? '\nJogo cancelado. Não atribui pontos.'
      : ['home', 'away'].includes(m.result)
        ? `\n✅ Vitória: **${safe(m.result === 'home' ? m.home : m.away)}**`
        : '',].join('\n'));
  return {
    embeds: [e], components: [ row( btn( `pick:${m.id}:home:${m.revision}`, `⚡ ${m.home}`, ButtonStyle.Success, !active), btn( `pick:${m.id}:away:${m.revision}`, `🔥 ${m.away}`, ButtonStyle.Danger, !active), btn( `my:${m.id}`, '📋 A minha escolha', ButtonStyle.Secondary)),], allowedMentions: { parse: [] }, };
}
function pickPreview(s, m, uid) {
  const d = s.drafts[m.id]?.[uid];
  need(d, 'Volta a escolher na publicação do jogo.');
  const old = s.boosts[m.date]?.[uid];
  const boostUsed = Boolean(old && old !== m.id);
  const e = baseEmbed('Confirma o teu prognóstico').setDescription([ `**${safe(m.home)} VS ${safe(m.away)}**`, '', `${d.side === 'home' ? '⚡' : '🔥'} A tua escolha: **${safe(d.side === 'home' ? m.home : m.away)}**`, '', `🎯 **${fmtOdd(chosenOdds(m, d.side) * (d.boost ? 2 : 1))} pontos** se acertares.${d.boost ? ' ⚡ Boost x2' : ''}`, '', boostUsed
      ? 'Já usaste o boost desta jornada noutro jogo.\n'
      : '', '**Confirmas?** Depois de confirmares, não podes alterar o prognóstico.',].join('\n'));
  return {
    content: '', embeds: [e], components: [ row( btn( `validate:${m.id}:${d.revision}:${d.version}`, '✅ Confirmar a minha escolha', ButtonStyle.Success), btn( `boost:${m.id}`, d.boost ? 'Retirar o boost' : '⚡ Boost x2', ButtonStyle.Primary, boostUsed), btn( `cancel:${m.id}`, 'Cancelar', ButtonStyle.Secondary)),], allowedMentions: { parse: [] }, };
}
function myChoice(s, m, uid) {
  const v = s.votes[m.id]?.[uid];
  if (!v) {
    return {
      content:
        'Ainda não confirmaste um prognóstico para este jogo. Escolhe uma equipa na publicação do jogo.', embeds: [], components: [], };
  }
  const boost = s.boosts[m.date]?.[uid] === m.id;
  const e = baseEmbed('✅ O teu prognóstico foi registado').setColor(0x2ECC71).setDescription([ `**${safe(m.home)} VS ${safe(m.away)}**`, '', `${v.side === 'home' ? '⚡' : '🔥'} A tua escolha: **${safe(v.side === 'home' ? m.home : m.away)}**`, '', `🎯 **${fmtOdd((v.odds ?? chosenOdds(m, v.side)) * (boost ? 2 : 1))} pontos** se acertares.${boost ? ' ⚡ Boost x2 registado.' : ''}`, '', 'A tua escolha é definitiva. Podes consultá-la em **A minha escolha**.',].join('\n'));
  return {
    content: '', embeds: [e], components: [], allowedMentions: { parse: [] }, };
}
function staffCard(m) {
  const labels = {
    scheduled: 'Agendado', published: 'Publicado', deleted: 'Eliminado', draft: 'Rascunho', };
  const e = baseEmbed(`📋 ${m.title}`).setDescription( `**ID :** \`${m.id}\`\n**Estado:** ${
        m.closedAt && m.status !== 'deleted'
          ? 'Prognósticos encerrados manualmente'
          : labels[m.status] || m.status
      }`).addFields( {
        name: 'Jogo', value: `${safe(m.home)} VS ${safe(m.away)}`, }, {
        name: 'Odds', value:
          `${safe(m.home)} : *${fmtOdd(m.homeOdds)}*\n` +
          `${safe(m.away)} : *${fmtOdd(m.awayOdds)}*`, }, {
        name: 'Publicação - Lisboa', value: formatTime(m.publishAt), inline: true, }, {
        name: 'Fecho - Lisboa', value: formatTime(m.closeAt), inline: true, }, {
        name: 'Jornada do boost', value: m.date, inline: true, }, {
        name: 'Canal', value: `<#${m.channelId}>`, inline: true, }, {
        name: 'Notificação', value: m.roleId ? `<@&${m.roleId}>` : 'Nenhuma', inline: true, }, {
        name: 'Resultado', value:
          m.result === 'void'
            ? 'Cancelado'
            : m.result === 'home'
              ? safe(m.home)
              : m.result === 'away'
                ? safe(m.away)
                : 'Pendente', inline: true, }, {
        name: 'Imagem', value: m.image
          ? `[Abrir imagem](${m.image})`
          : 'Nenhuma', }, {
        name: 'Texto', value: m.description
          ? safe(m.description).slice(0, 1000)
          : 'Texto predefinido', }).setFooter({ text: `GOAT Betclic | Ficha ${m.id}` });
  if (m.post?.id && m.status !== 'deleted') {
    e.addFields({
      name: 'Publicação', value:
        `[Abrir a publicação](https://discord.com/channels/` +
        `${process.env.DISCORD_GUILD_ID}/${m.post.channelId}/${m.post.id})`, });
  }
  return {
    embeds: [e],
    components: m.status === 'deleted' ? [] : [row(
      btn(`staff-result:${m.id}:home:${m.version}`, `A · ${m.home}`, ButtonStyle.Success, m.result !== null),
      btn(`staff-result:${m.id}:away:${m.version}`, `B · ${m.away}`, ButtonStyle.Primary, m.result !== null),
      btn(`staff-result:${m.id}:void:${m.version}`, 'Jogo cancelado', ButtonStyle.Secondary, m.result !== null),
    )],
    allowedMentions: { parse: [] },
  };
}
function rankCard(s, range, page = 0) {
  const values = rankings(s, range);
  const pages = Math.max(1, Math.ceil(values.length / 15));
  page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const pending = Object.values(s.matches).filter( m =>
      m.status !== 'deleted' &&
      (!range.start || m.date >= range.start) &&
      (!range.end || m.date <= range.end) &&
      m.result === null).length;
  const e = baseEmbed(`🏆 GOAT Betclic | Classificação ${range.label}`).setDescription( values.slice(page * 15, page * 15 + 15).map( r =>
            `**${r.rank}.** <@${r.uid}> | ` +
            `**${fmtOdd(r.points)} pts** | ${r.wins} prognósticos certos`).join('\n') ||
      'Nenhum prognóstico confirmado neste período.').addFields( {
        name: pending ? '⏳ Provisória' : '✅ Resultados registados', value: pending
          ? `${pending} resultado(s) por registar.`
          : 'Todos os resultados estão registados.', }, {
        name: 'Desempate', value:
          'Pontos, depois prognósticos certos e boosts vencedores. ' +
          'Se a igualdade persistir, os membros ficam empatados.', }).setFooter({
      text: `GOAT Betclic | Página ${page + 1}/${pages}`, });
  return {
    content: '', embeds: [e], components: [ row( btn( `rank:${range.start || 'all'}:${range.end || 'all'}:${page - 1}`, '←', ButtonStyle.Secondary, page === 0), btn( `rank:${range.start || 'all'}:${range.end || 'all'}:${page + 1}`, '→', ButtonStyle.Secondary, page === pages - 1)),], allowedMentions: { parse: [] }, };
}
function listCard(s, date, page = 0) {
  const values = Object.values(s.matches).filter( m => m.status !== 'deleted' && (!date || m.date === date)).sort( (a, b) =>
        b.date.localeCompare(a.date) ||
        a.publishAt - b.publishAt);
  const pages = Math.max(1, Math.ceil(values.length / 8));
  page = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const e = baseEmbed( date ? `📅 Jogos de ${date}` : '📅 GOAT Betclic | Jogos').setDescription( values.slice(page * 8, page * 8 + 8).map( m =>
            `**${safe(m.home)} / ${safe(m.away)}**\n` +
            `ID : \`${m.id}\` | ${m.status}\n` +
            `Publicação: ${formatTime(m.publishAt)}\n` +
            `Fecho: ${formatTime(m.closeAt)} | <#${m.channelId}>`).join('\n\n') ||
      'Ainda não há jogos. Usa /goat create-match.').setFooter({
      text: `GOAT Betclic | Página ${page + 1}/${pages}`, });
  return {
    embeds: [e], components: [ row( btn( `list:${date || 'all'}:${page - 1}`, '←', ButtonStyle.Secondary, page === 0), btn( `list:${date || 'all'}:${page + 1}`, '→', ButtonStyle.Secondary, page === pages - 1)),], allowedMentions: { parse: [] }, };
}
function addMatchOptions(s, edit = false) {
  if (edit) {
    s.addStringOption(o =>
      o.setName('id').setDescription('ID do jogo em /goat list').setRequired(true));
  }
  s.addStringOption(o =>
    o.setName('equipa-a').setDescription('Primeira equipa').setMaxLength(70).setRequired(!edit)).addStringOption(o =>
      o.setName('equipa-b').setDescription('Segunda equipa').setMaxLength(70).setRequired(!edit)).addNumberOption(o =>
      o.setName('odd-a').setDescription('Odd Betclic da primeira equipa').setMinValue(1).setMaxValue(10000).setRequired(!edit)).addNumberOption(o =>
      o.setName('odd-b').setDescription('Odd Betclic da segunda equipa').setMinValue(1).setMaxValue(10000).setRequired(!edit)).addStringOption(o =>
      o.setName('publicacao').setDescription( 'Hora de Lisboa : HH:mm AAAA-MM-DD, exemplo 07:00 2026-10-20').setRequired(!edit)).addStringOption(o =>
      o.setName('fecho').setDescription('Início do jogo, hora de Lisboa : HH:mm AAAA-MM-DD').setRequired(!edit)).addChannelOption(o =>
      o.setName('canal').setDescription('Canal de publicação').addChannelTypes( ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(!edit)).addStringOption(o =>
      o.setName('titulo').setDescription( 'Título opcional. Por defeito: Equipa A VS Equipa B').setMaxLength(200)).addStringOption(o =>
      o.setName('jornada').setDescription( 'Jornada GOAT: AAAA-MM-DD. Das 12h às 12h do dia seguinte, hora de Lisboa.')).addStringOption(o =>
      o.setName('texto').setDescription('Apresentação opcional').setMaxLength(1500)).addRoleOption(o =>
      o.setName('notificacao').setDescription('Cargo a notificar, opcional'));
  if (edit) {
    s.addBooleanOption(o =>
      o.setName('remover-notificacao').setDescription('Remover o cargo de notificação')).addBooleanOption(o =>
        o.setName('apagar-escolhas').setDescription( 'Permitir trocar as equipas e apagar os prognósticos, com confirmação'));
  }
  return s;
}
function addRangeOptions(s) {
  return s.addStringOption(o =>
    o.setName('periodo').setDescription('Semana atual ou classificação geral').addChoices( { name: 'Semana atual', value: 'semaine' }, { name: 'Geral', value: 'general' })).addStringOption(o =>
      o.setName('inicio').setDescription('Início personalizado : AAAA-MM-DD')).addStringOption(o =>
      o.setName('fim').setDescription('Fim personalizado : AAAA-MM-DD'));
}
function addProgramOptions(c, edit = false) {
  if (edit) c.addStringOption(o => o.setName('id').setDescription('ID do programa no canal da equipa').setRequired(true));
  c.addStringOption(o => o.setName('inicio').setDescription('Uma data da semana : AAAA-MM-DD').setRequired(!edit)).addStringOption(o => o.setName('publicacao').setDescription('Publicação (Lisboa) : HH:mm AAAA-MM-DD').setRequired(!edit)).addChannelOption(o => o.setName('canal').setDescription('Canal de publicação do programa').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(!edit)).addStringOption(o => o.setName('fim').setDescription('Domingo dessa semana. Se ficar vazio, é calculado automaticamente.')).addStringOption(o => o.setName('titulo').setDescription('Título personalizado do anúncio').setMaxLength(200)).addStringOption(o => o.setName('texto').setDescription('Texto do anúncio. Aceita Markdown e emojis e substitui o texto predefinido.').setMaxLength(5000)).addStringOption(o => o.setName('imagem').setDescription('URL da imagem da semana').setMaxLength(1000)).addRoleOption(o => o.setName('notificacao').setDescription('Cargo a notificar na publicação, opcional')).addChannelOption(o => o.setName('regulamento').setDescription('Canal do regulamento, usado no texto predefinido').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement));
  for (const day of DAYS) c.addStringOption(o => o.setName(PT_DAYS[day]).setDescription('Jogos de '+PT_DAYS[day]+', um por linha. Sem odds. Opcional.').setMaxLength(1000));
  if (!edit) c.addStringOption(o => o.setName('id').setDescription('Opcional: ID de um programa existente a alterar'));
  c.addBooleanOption(o => o.setName('remover-imagem').setDescription('Remover a imagem')).addBooleanOption(o => o.setName('remover-notificacao').setDescription('Remover o cargo a notificar')).addBooleanOption(o => o.setName('texto-predefinido').setDescription('Apagar o texto e voltar à apresentação predefinida'));
  return c;
}
// Copie du programme existant une seule fois : aucun lien dynamique avec les matchs.
function dayLabel(date) {
  return new Intl.DateTimeFormat('pt-PT', {timeZone: ZONE, day: '2-digit', month: '2-digit'}).format(new Date(date+'T12:00:00Z'));
}
function programCard(s, p) {
  const start = weekKey(p.start), end = shiftDate(start,6);
  let body = String(p.description || '');
  if (!body.trim()) {
    body = [ 'Todas as semanas, faz os teus prognósticos para **TODOS os jogos da NBA** e tenta tornar-te o **GOAT** e ganhar a tua parte dos **100 € em Freebets*** 👑', '', '🏆 **Os 5 melhores da semana recebem prémios todas as segundas-feiras às 12h**, antes de começar a jornada da nova semana.', '', `🗓️ **De segunda-feira ${dayLabel(start)} a domingo ${dayLabel(end)}**`, '', `🏀 Faz os teus prognósticos em <#${p.channelId}>.`, '', '⏰ **Volta TODOS OS DIAS às 12h** para veres os novos jogos e fazeres os teus prognósticos antes do início.', '', '🎯 Um prognóstico certo vale **os pontos da odd apresentada**. Acumula pontos durante a semana para subires na classificação.', '', '⚡ **Um boost x2 por jornada** para duplicar os pontos de um jogo. Depois de confirmada, a tua escolha é definitiva.', '', '🗓️ A semana vai **das 12h de segunda-feira às 12h da segunda-feira seguinte**. Os jogos da madrugada de segunda contam para domingo.', '',...DAYS.flatMap((day,n) => [ `${n > 4 ? '🔥' : '🏀'} **${PT_DAYS[day].toUpperCase()} ${dayLabel(shiftDate(start,n))}**`, p.blocks?.[day]?.trim() || 'Jogos a anunciar.', '',]), '*\\*Freebets = créditos de jogo não levantáveis*',...(p.rulesChannelId ? [`*Regulamento disponível em <#${p.rulesChannelId}>*`] : []),].join('\n');
  }
  need(body.length <= 5900, 'O programa é demasiado longo. Encurta o texto ou os jogos para ficares abaixo dos 5 900 caracteres.');
  // Un embed accepte 4 096 caractères. Le début d’un long texte passe en message.
  let content = '', rest = body;
  if (body.length > 4096) {
    const required = body.length - 4096;
    let cut = body.lastIndexOf('\n', 1900);
    if (cut < required) cut = 1900;
    if (/^[\uDC00-\uDFFF]$/.test(body[cut] || '')) cut--;
    if (body[cut-1] === '\\') cut--;
    content = body.slice(0,cut);
    rest = body.slice(cut);
  }
  need(rest.length <= 4096 && content.length <= 1900, 'O programa é demasiado longo. Encurta a lista de jogos.');
  const e = baseEmbed(p.title).setDescription(rest).setFooter({text: `GOAT Betclic | Programa ${p.id} | Semana ${start}`});
  return {content, embeds:[e], ...media(p,e), components:[], allowedMentions:{parse:[]}};
}
function programStaffCard(p) {
  return {
    embeds: [ baseEmbed(`📅 ${p.title}`).setDescription( `**ID do programa :** \`${p.id}\`\n` +
          `**Estado:** ${p.status}\n\n` +
          `**Período:** ${p.start} a ${p.end}\n` +
          `**Publicação (Lisboa) :** ${formatTime(p.publishAt)}\n` +
          `**Canal:** <#${p.channelId}>\n\n` +
          'Editar: usa /goat edit-week com este ID.\n' +
          'Eliminar: usa /goat delete-program com este ID.').setFooter({
          text: `GOAT Betclic | Ficha ${p.id}`, }),], allowedMentions: { parse: [] }, };
}
const command = new SlashCommandBuilder().setName('goat').setDescription('GOAT Betclic: jogos, resultados e classificações').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addSubcommand(s =>
    addProgramOptions( s.setName('schedule-week').setDescription( 'Agendar ou editar o anúncio semanal com a respetiva imagem'))).addSubcommand(s => addProgramOptions(s.setName('edit-week').setDescription('Editar um programa: indica o ID e as opções a alterar'), true)).addSubcommand(s =>
    s.setName('delete-program').setDescription('Eliminar um programa com confirmação').addStringOption(o =>
        o.setName('id').setDescription('ID do programa no canal da equipa').setRequired(true))).addSubcommand(s =>
    addMatchOptions( s.setName('create-match').setDescription( 'Criar e agendar um jogo num só comando'))).addSubcommand(s =>
    addMatchOptions( s.setName('edit-match').setDescription('Editar um jogo agendado ou publicado'), true)).addSubcommand(s =>
    s.setName('delete-match').setDescription('Eliminar um jogo com confirmação').addStringOption(o =>
        o.setName('id').setDescription('ID do jogo').setRequired(true))).addSubcommand(s =>
    s.setName('close-match').setDescription( 'Encerrar de imediato os prognósticos e manter as escolhas').addStringOption(o =>
        o.setName('id').setDescription('ID do jogo na ficha da equipa').setRequired(true))).addSubcommand(s =>
    s.setName('set-result').setDescription('Registar ou corrigir um resultado').addStringOption(o =>
        o.setName('id').setDescription('ID do jogo').setRequired(true)).addStringOption(o =>
        o.setName('vencedor').setDescription('Resultado').setRequired(true).addChoices( { name: 'Equipa A', value: 'home' }, { name: 'Equipa B', value: 'away' }, { name: 'Cancelado', value: 'void' }, { name: 'Pendente', value: 'pending' }))).addSubcommand(s =>
    addRangeOptions( s.setName('leaderboard').setDescription( 'Ver a classificação'))).addSubcommand(s =>
    addRangeOptions( s.setName('export').setDescription( 'Exportar os pontos e prognósticos em CSV'))).addSubcommand(s =>
    s.setName('list').setDescription('Ver os jogos e os respetivos IDs')).addSubcommand(s =>
    s.setName('day').setDescription('Ver os jogos de uma jornada').addStringOption(o =>
        o.setName('data').setDescription('AAAA-MM-DD').setRequired(true))).addSubcommand(s =>
    s.setName('diagnostic').setDescription( 'Verificar o armazenamento e os agendamentos'));

module.exports = { row, btn, publicCard, pickPreview, myChoice, staffCard, rankCard, listCard, programCard, programStaffCard, command };
