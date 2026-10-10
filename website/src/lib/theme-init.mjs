// The script every page runs in <head>, before anything is painted. It decides light or dark.
//
// One saved choice for the whole site, kept under Starlight's own key so the docs' switch and the
// ones on the home, how-it-works and comparison pages (src/components/ThemeToggle.astro on a wide
// screen, src/components/SiteThemeSelect.astro in the menu on a narrow one) read and write the same
// value: 'dark', 'light', or '' for "follow my system" (the Auto option).
//
// A first-time visitor gets dark. Starlight on its own would follow the system setting and save
// '' on the first docs visit, so "never chose" and "chose Auto" would look the same. The marker
// key below records that the dark default was applied once in this browser; after that an empty
// value means the visitor picked Auto, and it is respected.
//
// With scripts off, the stylesheet's own default applies, which is also dark (palette.css).
export const THEME_KEY = 'starlight-theme';
export const THEME_DEFAULT_MARKER = 'realm-theme-default';

export const THEME_INIT = `(function(){
var d=document.documentElement;
function apply(){
var t='dark';
try{
var s=localStorage.getItem('${THEME_KEY}');
if(!localStorage.getItem('${THEME_DEFAULT_MARKER}')){
if(!s){s='dark';localStorage.setItem('${THEME_KEY}',s)}
localStorage.setItem('${THEME_DEFAULT_MARKER}','dark')}
t=s||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');
}catch(e){}
d.dataset.theme=t==='light'?'light':'dark';
}
apply();
window.addEventListener('pageshow',function(e){
if(!e.persisted)return;
apply();
try{if(window.StarlightThemeProvider)window.StarlightThemeProvider.updatePickers(localStorage.getItem('${THEME_KEY}')||'auto')}catch(x){}
});
})();`.replace(/\n/g, '');
