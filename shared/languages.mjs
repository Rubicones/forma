// BCP-47 codes offered in the UI. dir:'rtl' mirrors layouts. cjk:true switches reading-time units to characters.
export const LANGUAGES = [
  {code:'ru', name:'Русский'}, {code:'en', name:'English'}, {code:'sr-Latn', name:'Srpski (latinica)'},
  {code:'sr-Cyrl', name:'Српски (ћирилица)'}, {code:'uk', name:'Українська'}, {code:'de', name:'Deutsch'},
  {code:'fr', name:'Français'}, {code:'es', name:'Español'}, {code:'it', name:'Italiano'}, {code:'pt', name:'Português'},
  {code:'pl', name:'Polski'}, {code:'tr', name:'Türkçe'}, {code:'nl', name:'Nederlands'}, {code:'kk', name:'Қазақша'},
  {code:'ar', name:'العربية', dir:'rtl'}, {code:'he', name:'עברית', dir:'rtl'},
  {code:'zh', name:'中文', cjk:true}, {code:'ja', name:'日本語', cjk:true}, {code:'ko', name:'한국어', cjk:true},
];
export const language = code => LANGUAGES.find(l => l.code === code) || {code, name:code};
export const isRTL = code => language(code).dir === 'rtl';
