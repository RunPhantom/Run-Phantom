export const ACCESSIBILITY_FIXTURE_HTML = `<!doctype html><html lang="en"><head><title>Local accessibility fixture</title><style>body{background:white;color:black;font:16px Arial}button,input{min-height:44px}section{min-height:44px}#empty{width:100px;height:44px}</style></head><body>
<main><section id="audit"><button id="unnamed"></button><img id="image"><input id="entry"><p>Readable text</p></section>
<button id="fix" type="button">Fix local controls</button><a id="navigate" href="/next">Navigate local page</a>
<section id="empty"></section><section id="opaque"><button>Accessible control</button><div id="closed"></div></section>
<section id="frameaudit"><button>Accessible control</button><iframe title="Excluded child" srcdoc="<button></button>"></iframe></section></main>
<script>document.querySelector('#closed').attachShadow({mode:'closed'}).innerHTML='<button></button>';
document.querySelector('#fix').addEventListener('click',()=>{document.querySelector('#unnamed').textContent='Save';document.querySelector('#image').setAttribute('alt','Decorative local image');document.querySelector('#entry').setAttribute('aria-label','Name')});</script></body></html>`;
