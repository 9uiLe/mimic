type ResolvedTokens = Readonly<Record<string, unknown>>;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const colors = [
  ['canvas', 'ページの背景', 'text・muted・linkを載せる面'],
  ['text', '本文・見出し', 'canvas・subtle上'],
  ['muted', '補足', 'canvas・subtle上'],
  ['subtle', 'コード・表の見出しの背景', 'text・muted・linkを載せる面。開いた疑問には使わない'],
  ['border', '区切りの補助線', 'canvas・subtleに接する線'],
  ['link', 'リンクの文字', 'canvas・subtle上。通常・visited・focus'],
  ['linkHover', 'リンクの文字', 'canvas・subtle上。hover・activeも黒、下線を太くする'],
  ['focus', '操作中の輪郭', 'canvas・subtleに接する輪郭'],
] as const;
const typeRoles = [
  ['body', '本文'], ['display', '見本用の大見出し'], ['title', 'ページ題名'], ['section', '章'],
  ['subheading', '小見出し'], ['label', '名称'], ['supporting', '補足'], ['code', 'コード'],
] as const;
const typeFields = [
  ['fontFamily', '書体・代替書体'], ['fontSize', '文字サイズ'], ['fontWeight', '太さ'],
  ['letterSpacing', '字間'], ['lineHeight', '行高'],
] as const;

/** Trusted generated examples beside the untouched Markdown article; values come from the validated token compiler. */
export function renderDesignSpecimens(resolved: ResolvedTokens) {
  const colorRows = colors.map(([role, purpose, background]) => {
    const name = `role.color.${role}`;
    const value = resolved[name];
    if (typeof value !== 'string') throw new Error(`Missing color specimen token: ${name}`);
    const appearance = role === 'focus' ? 'specimen-chip-focus' : role === 'border' ? 'specimen-chip-border' : 'specimen-chip-fill';
    return `<li class="color-specimen"><span class="specimen-chip ${appearance}" aria-hidden="true"
style="--specimen-color:var(--role-color-${role === 'linkHover' ? 'link-hover' : role})"></span>
<div><p class="type-label">${purpose}</p><p class="type-code">${name} · ${escape(value)}</p>
<p class="type-supporting">${background}</p></div></li>`;
  }).join('\n');
  const combinations = ['canvas', 'subtle'].map(background => `<figure class="color-combination"
style="background:var(--role-color-${background})"><figcaption class="type-code">背景: role.color.${background}</figcaption>
<p>本文と見出し — role.color.text</p><p class="specimen-muted">補足 — role.color.muted</p>
<p><a href="#色の役割と組合せ">リンクの見本 — role.color.link</a></p>
<p class="type-supporting">focus輪郭の見本 — role.color.focus</p>
<p><span class="specimen-focus-outline">操作対象の輪郭</span></p></figure>`).join('\n');
  const typeRows = typeRoles.map(([role, label]) => {
    const name = `role.type.${role}`;
    const typography = resolved[name];
    if (!typography || typeof typography !== 'object' || Array.isArray(typography)) throw new Error(`Missing type specimen token: ${name}`);
    const values = typography as Record<string, unknown>;
    const metadata = typeFields.map(([field, fieldLabel]) => {
      const value = values[field];
      if (value === undefined) throw new Error(`Missing type specimen field: ${name}.${field}`);
      return `<div><dt>${fieldLabel}</dt><dd>${escape(Array.isArray(value) ? value.join(', ') : value)}</dd></div>`;
    }).join('');
    const responsive = role === 'display' || role === 'title'
      ? `<p class="type-supporting">狭幅の文字サイズ: ${escape(resolved[`role.responsive.${role}Size`])}（ほかの四要素は共通）</p>` : '';
    return `<li class="type-specimen"><h3 class="type-label">${label} <span class="type-code">${name}</span></h3>
<p class="type-${role} specimen-text">知識を読み、違いを確かめる。Design for UI 0123456789</p>
${role === 'code' ? '<p class="type-code specimen-text">const knowledgeCount = 20;</p>' : ''}
<dl class="specimen-type-values type-supporting">${metadata}</dl>${responsive}</li>`;
  }).join('\n');
  return `<div class="design-specimens">
<section id="design-color-specimens" aria-labelledby="design-color-title"><h2 id="design-color-title" class="type-section">色見本と組合せ</h2>
<p class="type-supporting">design/tokens.jsonの現在値。light・sRGB・不透明。強制カラー表示ではシステムの色に置き換わります。</p>
<ul class="color-specimens">${colorRows}</ul><h3 class="type-subheading">背景との組合せ</h3>
<div class="color-combinations">${combinations}</div><p><a href="#色の役割と組合せ">色の役割と組合せの規定へ戻る</a></p></section>
<section id="design-type-specimens" aria-labelledby="design-type-title"><h2 id="design-type-title" class="type-section">Typographyの文字見本</h2>
<p class="type-supporting">8役割を同じ文で比較します。日本語と英数字の横組。書体は利用環境により代替され、幅と文字設定に応じて折り返します。</p>
<ul class="type-specimens">${typeRows}</ul><p><a href="#typographyと適応">Typographyと適応の規定へ戻る</a></p></section></div>`;
}
