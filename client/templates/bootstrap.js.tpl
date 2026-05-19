

<%= renderer.include('scripts.tpl') %>

let count = 0;
function load_bundle(id, src){
  let el = document.createElement('script');
  let type= 'text/javascript';
  el.setAttribute('text', type);
  el.type = type;
  el.setAttribute('async', "true");
  el.setAttribute('charset', "utf-8");
  el.setAttribute('crossorigin', "true");
  el.setAttribute('id', id);
  el.onload = (e) => {
    count++;
    let el = document.getElementById("warmup-progess")
    console.log("Loading app bundles", e.target?.id)
    let w = 100 * (count / 4) + '%';
    if (el) {
      el.style.width = w;
    }
  };
  el.setAttribute('src', src);
  document.head.appendChild(el);
}

<% _.each(bundles, function(m, k) { %>
  load_bundle("bundles-<%= k %>", "<%= m %>")
<% }); %>


