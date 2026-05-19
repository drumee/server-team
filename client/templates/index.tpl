<!DOCTYPE html>
<!--
 ____  _ __ _   _ _   _  ___  ___
|  _ \| '__| | | | \_/ |/ _ \/ _ \
| |_) | |  | |_| | | | | \__/ \__/
|____/|_|  (_____|_| |_|\___|\___|

-->

<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset=UTF-8>
    <meta http-equiv="Content-Type" content="text/html">
    <meta http-equiv="Content-Language" content="<%= language %>,en">
    <meta name="description" content="<%= description %>">
    <meta name="keywords" content="<%= keywords %>">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
    <meta http-equiv="Cache-Control" content="no-cache" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <% _.each(meta, function(m) { %>
      <meta name="<%= m.name %>" content="<%= m.content %>">
    <% }); %>
    <title>
      <%= title %>
    </title>
    <link rel="icon" href="<%= icon %>" type="image/svg">
    <link rel="stylesheet" href="/-/static/styles/loader.css?v=1.0.2" media="screen"></link>
    <link rel="stylesheet" href="/-/static/fonts/Armin-Grotesk/stylesheet.css" media="screen"></link>
    
    <script>
    <%= renderer.include('bootstrap.js.tpl') %>
    </script>

    <% if (typeof(loader) !== "undefined" && loader) { %>
      <script defer type="text/javascript" src="<%= loader %>"></script> 
    <% } %>

    <% if (typeof(debugUi) !== "undefined" && debugUi) { %>
      <script>localStorage.logLevel = "3;</script>
    <% } %>


  </head>

  <body style="background-color:#f6f6f6;" 
    data-instance="<%= instance %>" 
    data-head="<%= app.head %>" 
    data-hash="<%= app.hash %>" 
    data-timestamp="<%= app.timestamp %>">
    <div class="margin-auto <%= ident %>-top" id="--router">
    <%= renderer.include('warmup.html') %>
    </div>
    <div class="margin-auto" id="--wrapper"></div>
    <% if (typeof(debugUi) !== "undefined" && debugUi) { %>
      <script src="https://cdn.jsdelivr.net/npm/eruda"></script>
      <script>eruda.init();</script>
    <% } %>
  </body>
</html>
