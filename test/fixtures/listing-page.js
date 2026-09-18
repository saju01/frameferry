'use strict';
// Shared synthetic provider page, shaped like the REAL captured representation.
//
// The listing bodies these helpers build use the observed `p`/`pc` object and the observed item
// key sets, and the page renderer flattens each primary plus its `om` children and paints
// reverse(vhu|hu) as the /media?id= locator - the mapping verified tuple-by-tuple against the
// authorized offline capture. Tests that need a listing response should build it here rather
// than inventing a body shape, so a fixture can never be more permissive than the decoder.
// --- the observed provider representation, built for tests -------------------------------
// `hu`/`vhu` are opaque strings whose REVERSE is the rendered /media?id= identity, exactly as
// verified for all 13 captured tuples. Tests name a readable media id and this reverses it.
const opaque=s=>[...s].reverse().join('');
function rec({code,media,type='image',date='1 January 2026',children=[]}){
 const r={iu:opaque('iu-'+media),hu:opaque(media),lc:'10',cc:'2',pd:date,c:'caption text',id:'postid-'+code,co:code};
 if(type==='video'){r.vu=opaque(media);r.vhu=opaque(media);}
 if(children.length)r.om=children.map(child=>({iu:opaque('iu-'+child.media),hu:opaque(child.media),
  lc:'10',cc:'2',pd:date,c:'caption text',id:'postid-'+code,co:code}));
 return r;
}
const posts=(...records)=>({p:records,pc:'0123456789_0123'});

// A card as the provider paints it: the shortcode on .likes-trigger, the media type on
// .post-image, the locator on .content-download-btn and the date in the last footer group.
const card=(id,{shortcode=id,year=2026,type='image',date=null}={})=>'<div class="post-card">'
 +'<img class="post-image" data-type="'+type+'">'
 +'<a class="content-download-btn" href="/media?id='+encodeURIComponent(id)+'"></a>'
 +'<div class="likes-trigger" data-id="'+shortcode+'"><span>10</span></div>'
 +'<div class="post-footer"><span class="icon-group"><span>'+(date||('1 January '+year))+'</span></span></div></div>';
const PROFILE='document.getElementById("profile-section").innerHTML=\'<span class="username-text">@example</span> 1 posts\';';
const document_=(script,initial='')=>'<input id="search-input"><button id="download-btn" onclick="show()">Search</button>'
 +'<div id="profile-section"></div><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div>'
 +'<div id="post-container">'+initial+'</div><script>'+script+'</script>';
// The page's own renderer for the observed representation: flatten each primary plus its `om`
// children in order, and paint reverse(vhu|hu) as the /media?id= locator.
const RENDERER='function ffRev(s){return s.split("").reverse().join("");}'
 +'function ffFlat(d){var out=[];(d.p||[]).forEach(function(r){out.push(r);(r.om||[]).forEach(function(k){out.push(k);});});return out;}'
 +'function ffPaint(d){document.getElementById("post-container").innerHTML=ffFlat(d).map(function(r){'
 +'var vid=Object.prototype.hasOwnProperty.call(r,"vu");'
 +'return \'<div class="post-card"><img class="post-image" data-type="\'+(vid?"video":"image")+\'">\''
 +'+\'<a class="content-download-btn" href="/media?id=\'+encodeURIComponent(ffRev(vid?r.vhu:r.hu))+\'"></a>\''
 +'+\'<div class="likes-trigger" data-id="\'+r.co+\'"><span>\'+r.lc+\'</span></div>\''
 +'+\'<div class="post-footer"><span class="icon-group"><span>\'+r.pd+\'</span></span></div></div>\';}).join("");}';
const responsePage=body=>RENDERER+';window.trace=[];function show(){'
 +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
 +'fetch("/api/posts").then(function(r){return r.json();}).then(function(d){window.trace.push("decoded");'+body+'});}';
const paintNow='ffPaint(d);window.trace.push("rendered");';
const paintAfter=ms=>'setTimeout(function(){ffPaint(d);window.trace.push("rendered");},'+ms+');';


module.exports={opaque,rec,posts,card,PROFILE,document_,RENDERER,responsePage,paintNow,paintAfter};
