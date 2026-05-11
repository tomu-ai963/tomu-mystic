(function () {
  var style = document.createElement('style');
  style.textContent = [
    '#mystic-back-header{',
    '  position:fixed;top:0;left:0;right:0;z-index:9999;',
    '  height:44px;',
    '  padding-top:env(safe-area-inset-top);',
    '  background:rgba(0,0,0,0.8);',
    '  display:flex;align-items:center;',
    '  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    '}',
    '#mystic-back-header a{',
    '  color:#d4af37;',
    '  text-decoration:none;',
    '  font-size:14px;font-weight:bold;letter-spacing:0.05em;',
    '  padding:0 16px;',
    '  line-height:44px;',
    '}'
  ].join('');
  document.head.appendChild(style);

  var header = document.createElement('div');
  header.id = 'mystic-back-header';
  var link = document.createElement('a');
  link.href = 'https://tomu-ai963.github.io/mystic-system/';
  link.textContent = '← とむMYSTIC';
  header.appendChild(link);

  document.addEventListener('DOMContentLoaded', function () {
    document.body.insertBefore(header, document.body.firstChild);
    var pt = parseInt(getComputedStyle(document.body).paddingTop, 10) || 0;
    document.body.style.paddingTop = (pt + 44) + 'px';
  });
})();
