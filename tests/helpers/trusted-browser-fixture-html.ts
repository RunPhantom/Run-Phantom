/** Controlled browser target; it is not a real provider/business integration. */
export const TRUSTED_BROWSER_FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;padding:24px}button,input,select{margin:8px;padding:10px}.drag{width:100px;height:60px;background:#ccc;margin:20px;display:inline-block}#menu{visibility:hidden}#hover:hover #menu{visibility:visible}</style></head><body>
  <h1>Controlled browser input fixture</h1><button id="pay">Pay</button><button id="broken">Broken</button>
  <button id="duplicates">Duplicate requests</button><button id="delayed">Delayed body</button>
  <div style="position:relative;width:180px;height:60px"><button id="covered">Covered action</button><div style="position:absolute;inset:0;background:#eee">Blocked target overlay</div></div>
  <label>Name<input id="name" value="old value"></label><input id="file" type="file"><input id="readonly" readonly value="unchanged">
  <select id="plan"><option value="a">Alpha</option><option value="b" selected>Beta</option><option value="c">Gamma</option></select>
  <div id="hover" tabindex="0">Hover menu<span id="menu">Visible menu</span></div>
  <div id="from" class="drag">Drag source</div><div id="to" class="drag">Drop zone</div><div data-runphantom-private>PRIVATE PIXELS</div>
  <div id="always">Already present</div><pre id="result">Original output Café 東京</pre><script>
  const send=(type,e,value)=>fetch('/events',{method:'POST',body:JSON.stringify({type,trusted:e.isTrusted,...(value===undefined?{}:{value})})});
  console.log('initial controlled capture');
  document.querySelector('#pay').addEventListener('click',e=>{send('click',e);if(e.isTrusted){document.querySelector('#result').textContent='Payment accepted';send('output',e,document.querySelector('#result').textContent);fetch('/accepted');document.querySelector('#result').insertAdjacentHTML('afterend','<div id="paid">Payment complete</div>')}});
  document.querySelector('#broken').addEventListener('click',e=>{send('broken',e,document.querySelector('#result').textContent);if(e.isTrusted)fetch('/accepted')});
  document.querySelector('#name').addEventListener('input',e=>{send('input',e,e.target.value);if(e.target.value==='error')console.error(e.target.value);else console.warn('Controlled echo: '+e.target.value)});
  document.querySelector('#covered').addEventListener('click',e=>{send('covered',e);if(e.isTrusted)document.querySelector('#result').textContent='UNEXPECTED COVERED MUTATION'});
  document.querySelector('#duplicates').addEventListener('click',e=>{if(e.isTrusted)Promise.all([fetch('/duplicate'),fetch('/duplicate')]).then(()=>document.querySelector('#result').insertAdjacentHTML('afterend','<div id="duplicates-done">Both finished</div>'))});
  document.querySelector('#delayed').addEventListener('click',e=>{if(e.isTrusted)fetch('/delayed-body').then(r=>r.text()).then(()=>console.error('Delayed controlled error'))});
  document.querySelector('#name').addEventListener('keydown',e=>send('key',e,e.key));
  document.querySelector('#plan').addEventListener('change',e=>send('select',e,e.target.value));
  document.querySelector('#hover').addEventListener('mouseover',e=>send('hover',e));
  document.querySelector('#from').addEventListener('pointerdown',e=>send('drag-start',e));
  document.querySelector('#to').addEventListener('pointerup',e=>send('drag-end',e));
  </script></body></html>`;
