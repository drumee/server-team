
  const xia_lang = "<%= language %>";

  const startTime = new Date().getTime();
  const bootstrap = function() {
    let protocol = "<%= protocol %>" || location?.protocol;
    protocol = protocol.replace(/[: ]+/, '');
    return {
      access        : "<%= access %>",
      appHash       : "<%= app.hash %>",
      appRoot       : "<%= appRoot %>",
      arch          : "<%= arch %>",
      area          : "<%= area %>",
      connection    : "<%= connection %>",
      endpoint      : "<%= endpointPath %>/",
      endpointName  : "<%= instance_name %>",
      endpointPath  : "<%= endpointPath %>/",
      ident         : "<%= ident %>",
      icons         : "<%= appRoot %>/static/icons",
      instance      : "<%= instance_name %>",
      instance_name : "<%= instance_name %>",
      isPlugin      : <%= typeof(isPlugin) === 'undefined' ? 0:1 %>,
      keysel        : "<%= keysel %>",
      lang          : "<%= language %>",
      localhost     : <%= localhost %>,
      main_domain   : "<%= main_domain %>",
      mfs_base      : "<%= endpointPath %>/",
      mfsRootUrl    : `<%= endpointPath %>/`,
      online        : 1,
      pdfium_wasm   : "<%= appRoot %>/static/vendor/embedpdf/pdfium.wasm",
      protocol,
      service       : "<%= servicePath %>?",
      serviceApi    : "<%= servicePath %>?",
      servicePath   : "<%= servicePath %>",
      serviceUrl    : "<%= protocol %>://<%= main_domain %><%= svcPath %>",
      signed_in     : <%= signed_in || 0 %>,
      startTime,
      static        : "<%= appRoot %>/static/",
      svc           : "<%= svcPath %>",
      uid           : "<%= uid %>",
      user_domain   : "<%= user_domain %>",
      vdo           : "<%= vdoPath %>",
      websocketApi  : "<%= ws_protocol %>://<%= main_domain %><%= ws_port %><%= websocketPath %>",
      websocketPath : "<%= websocketPath %>",
    };
  }

  const DEBUG =  {};
