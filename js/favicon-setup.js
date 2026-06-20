(function(){
  var fav='assets/notelix-favicon.svg';
  var apple='assets/apple-touch-icon.png';
  function setup(){
    document.querySelectorAll('link[rel="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"]').forEach(function(e){e.parentNode.removeChild(e);});
    var l=document.createElement('link');
    l.rel='apple-touch-icon';l.setAttribute('sizes','1024x1024');l.href=apple;
    document.head.insertBefore(l,document.head.firstChild);
    var fi=document.querySelector('link[rel="icon"]');if(fi)fi.href=fav;
    document.querySelectorAll('link[rel="manifest"]').forEach(function(e){e.parentNode.removeChild(e);});
    try{
      var m={name:'Notelix',short_name:'Notelix',start_url:'.',display:'standalone',
             background_color:'#070709',theme_color:'#070709',
             icons:[{src:apple,sizes:'1024x1024',type:'image/png',purpose:'any maskable'}]};
      var blob=new Blob([JSON.stringify(m)],{type:'application/manifest+json'});
      var ml=document.createElement('link');ml.rel='manifest';ml.href=URL.createObjectURL(blob);
      document.head.appendChild(ml);
    }catch(e){}
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',setup);}
  else{setup();}
})();
