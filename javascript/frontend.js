/* Screenroom – front end. No dependencies. */
( function () {
	'use strict';

	var CONSENT_KEY = 'vsfy-consent';
	var YT_ORIGIN = 'https://www.youtube-nocookie.com';
	var facades = typeof WeakMap === 'function' ? new WeakMap() : null;
	var endHandlers = [];
	var startWatch = [];
	var playerId = 0;
	var consentedThisPage = false;

	function hasConsent() {
		try {
			return window.localStorage.getItem( CONSENT_KEY ) === '1';
		} catch ( e ) {
			return false;
		}
	}

	function rememberConsent() {
		try {
			window.localStorage.setItem( CONSENT_KEY, '1' );
		} catch ( e ) {}
	}

	// Cookie banners
	// Checked at click time, so a choice made a moment earlier counts. Each check returns true or false (false also
	// before any choice), or null when its banner is absent or has no YouTube service, which they all call "youtube".
	var ucServices = null; // Usercentrics 3 only answers asynchronously; keep the copy from its event.
	window.addEventListener( 'UC_CONSENT', function ( e ) {
		if ( e.detail && e.detail.services ) {
			ucServices = e.detail.services;
		}
	} );

	function youtubeIn( services, read ) {
		var keys = Object.keys( services || {} );
		for ( var i = 0; i < keys.length; i++ ) {
			var svc = services[ keys[ i ] ];
			if ( svc && /youtube/i.test( svc.name || '' ) ) {
				return read( svc );
			}
		}
		return null;
	}

	var BANNERS = [
		function () { // custom: window.devenziVideoConsent = function () { return true; }
			return typeof window.devenziVideoConsent === 'function' ? window.devenziVideoConsent() : null;
		},
		function () { // Borlabs Cookie 3 and 2.
			var b = window.BorlabsCookie;
			if ( b && b.Consents && typeof b.Consents.hasConsent === 'function' ) {
				if ( b.Services && typeof b.Services.findByServiceId === 'function' && ! b.Services.findByServiceId( 'youtube' ) ) {
					return null;
				}
				return !! b.Consents.hasConsent( 'youtube' );
			}
			return b && typeof b.checkCookieConsent === 'function' ? !! b.checkCookieConsent( 'youtube' ) : null;
		},
		function () { // Complianz: the service if decided on its own, otherwise its category.
			if ( typeof window.cmplz_has_service_consent === 'function' ) {
				return !! window.cmplz_has_service_consent( 'youtube', 'marketing' );
			}
			return typeof window.cmplz_has_consent === 'function' ? !! window.cmplz_has_consent( 'marketing' ) : null;
		},
		function () { // Real Cookie Banner.
			var api = window.consentApi;
			var r = api && typeof api.consentSync === 'function' ? api.consentSync( 'youtube' ) : null;
			return r && r.cookie ? !! r.cookieOptIn : null;
		},
		function () { // CookieYes: YouTube's cookies fall under advertisement there.
			var c = typeof window.getCkyConsent === 'function' ? window.getCkyConsent() : null;
			return c && c.categories ? !! c.categories.advertisement : null;
		},
		function () { // Cookiebot: YouTube falls under marketing.
			var c = window.Cookiebot;
			return c && c.consent && typeof c.consent === 'object' ? !! c.consent.marketing : null;
		},
		function () { // Usercentrics 3 (from its event) and 2.
			if ( ucServices ) {
				return youtubeIn( ucServices, function ( svc ) { return !! ( svc.consent && svc.consent.given ); } );
			}
			var ui = window.UC_UI;
			var list = ui && typeof ui.getServicesBaseInfo === 'function' && ( typeof ui.isInitialized !== 'function' || ui.isInitialized() ) ? ui.getServicesBaseInfo() : null;
			return Array.isArray( list ) ? youtubeIn( list, function ( svc ) { return !! ( svc.consent && svc.consent.status ); } ) : null;
		},
		function () { // Klaro: only a saved choice counts, not the defaults shown before it.
			var m = window.klaro && typeof window.klaro.getManager === 'function' ? window.klaro.getManager() : null;
			return m && m.getService( 'youtube' ) ? !! ( m.confirmed && m.getConsent( 'youtube' ) ) : null;
		},
	];

	function bannerConsent() {
		for ( var i = 0; i < BANNERS.length; i++ ) {
			try {
				var r = BANNERS[ i ]();
				if ( r === true || r === false ) {
					return r;
				}
			} catch ( e ) {}
		}
		return null;
	}

	function svg( path ) {
		return '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="' + path + '"/></svg>';
	}

	var EASE = 'cubic-bezier(.2, .7, .2, 1)';

	function calm() {
		return !! ( window.matchMedia && window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches );
	}

	function animate( el, frames, opts ) {
		if ( ! el || typeof el.animate !== 'function' || calm() ) {
			return null;
		}
		return el.animate( frames, opts );
	}

	function after( anim, fn ) {
		if ( anim ) {
			anim.onfinish = fn;
			anim.oncancel = fn;
		} else {
			fn();
		}
	}

	function detach( el ) {
		if ( el && el.parentNode ) {
			el.parentNode.removeChild( el );
		}
	}

	function freshen( el ) {
		animate( el, [ { opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' } ], { duration: 360, easing: EASE } );
	}

	// Fades the player in over the thumbnail once loaded, so there is no black flash.
	function whenReady( iframe, done ) {
		var fired = false;
		var ready = function () {
			if ( fired ) {
				return;
			}
			fired = true;
			iframe.classList.add( 'is-ready' );
			if ( done ) {
				done();
			}
		};
		iframe.addEventListener( 'load', ready );
		setTimeout( ready, 4000 ); // some blockers swallow the load event
	}

	function pauseFrame( iframe ) {
		if ( iframe && iframe.contentWindow ) {
			iframe.contentWindow.postMessage( JSON.stringify( { event: 'command', func: 'pauseVideo', args: [] } ), YT_ORIGIN );
		}
	}

	// fn( 1 ) next, fn( -1 ) previous. Touches inside a playing iframe never reach the page, so the player keeps them.
	function swipe( el, fn ) {
		var x = 0;
		var y = 0;
		el.addEventListener( 'touchstart', function ( e ) {
			x = e.touches[ 0 ].clientX;
			y = e.touches[ 0 ].clientY;
		}, { passive: true } );
		el.addEventListener( 'touchend', function ( e ) {
			var t = e.changedTouches[ 0 ];
			var dx = t.clientX - x;
			if ( Math.abs( dx ) > 50 && Math.abs( dx ) > Math.abs( t.clientY - y ) * 1.5 && ! e.target.closest( 'button:not([data-vsfy-facade])' ) ) {
				fn( dx < 0 ? 1 : -1 );
			}
		}, { passive: true } );
	}

	// Mirrors Devenzi_Video_Render::linkify().
	function linkify( el, text ) {
		el.textContent = '';
		String( text || '' ).split( /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/ ).forEach( function ( part, i ) {
			if ( i % 2 ) {
				var a = document.createElement( 'a' );
				a.href = part;
				a.target = '_blank';
				a.rel = 'noopener nofollow';
				a.textContent = part;
				el.appendChild( a );
			} else if ( part ) {
				el.appendChild( document.createTextNode( part ) );
			}
		} );
	}

	function setupDesc( box ) {
		var p = box.querySelector( 'p' );
		var more = box.querySelector( '.vsfy-desc-more' );
		if ( ! p || ! more ) {
			return;
		}
		var label = more.textContent;
		function fit() {
			box.classList.remove( 'is-open' );
			more.setAttribute( 'aria-expanded', 'false' );
			more.textContent = label;
			more.hidden = p.scrollHeight <= p.clientHeight + 2;
		}
		more.addEventListener( 'click', function () {
			var open = ! box.classList.contains( 'is-open' );
			box.classList.toggle( 'is-open', open );
			more.setAttribute( 'aria-expanded', open ? 'true' : 'false' );
			more.textContent = open ? more.getAttribute( 'data-label-less' ) : label;
		} );
		box.vsfyFit = fit;
		fit();
	}

	function thumbOf( el ) {
		var img = el && el.querySelector( 'img' );
		return img ? ( img.currentSrc || img.getAttribute( 'src' ) || '' ) : '';
	}

	// Player state arrives via YouTube's postMessage API, so the IFrame API script is not needed.
	window.addEventListener( 'message', function ( e ) {
		if ( e.origin !== YT_ORIGIN || typeof e.data !== 'string' ) {
			return;
		}
		var data;
		try {
			data = JSON.parse( e.data );
		} catch ( err ) {
			return;
		}
		var state = data.event === 'onStateChange' ? data.info : ( data.info && data.info.playerState );
		// Playing (1) or buffering (3): the tap started the video, no muted fallback needed.
		// Unstarted (-1) or cued (5): the player answers but waits, which is what a blocked start looks like.
		if ( typeof state === 'number' ) {
			startWatch.forEach( function ( w ) {
				if ( w.frame.contentWindow === e.source ) {
					w.last = state;
					if ( state === 1 || state === 3 ) {
						w.started = true;
					} else if ( ( state === -1 || state === 5 ) && ! w.timer ) {
						w.arm();
					}
				}
			} );
		}
		if ( state !== 0 ) {
			return;
		}
		endHandlers.forEach( function ( h ) {
			if ( h.frame.contentWindow === e.source ) {
				h.done();
			}
		} );
	} );

	// Phones (Safari above all) do not let a player loaded after the tap start with sound: YouTube then waits for a
	// second tap on its own play button. A script cannot tap for the visitor, but it can see that the player
	// reported waiting and never started, and start the video muted, which every browser allows; YouTube then offers
	// "Tap to unmute" in the player. Without any answer from the player (blocked messages, slow start) nothing is
	// muted, so a video that does play keeps its sound.
	var MUTED_FALLBACK_MS = 2500;
	function watchStart( iframe, send ) {
		var w = { frame: iframe, started: false, last: null, timer: 0 };
		// The wait starts with the player's first "waiting" answer, not with the iframe, so a slow load does not count.
		w.arm = function () {
			w.timer = setTimeout( function () {
				if ( ! w.started && ( w.last === -1 || w.last === 5 ) && document.contains( iframe ) ) {
					send( { event: 'command', func: 'mute', args: [] } );
					send( { event: 'command', func: 'playVideo', args: [] } );
				}
				startWatch = startWatch.filter( function ( x ) { return x !== w; } );
			}, MUTED_FALLBACK_MS );
		};
		startWatch = startWatch.filter( function ( x ) { return document.contains( x.frame ); } );
		startWatch.push( w );
		// Without any answer the watch ends quietly after a while.
		setTimeout( function () {
			if ( ! w.timer ) {
				startWatch = startWatch.filter( function ( x ) { return x !== w; } );
			}
		}, 4 * MUTED_FALLBACK_MS );
	}

	function makeIframe( id, title, onEnd, start, root ) {
		var iframe = document.createElement( 'iframe' );
		var origin = encodeURIComponent( window.location.origin );
		var extra = start > 0 ? '&start=' + Math.floor( start ) : '';
		var muted = root && root.getAttribute( 'data-muted' ) === '1';
		if ( root && root.getAttribute( 'data-captions' ) === '1' ) {
			extra += '&cc_load_policy=1&cc_lang_pref=' + encodeURIComponent( ( document.documentElement.lang || 'en' ).split( '-' )[ 0 ] );
		}
		if ( muted ) {
			extra += '&mute=1';
		}
		iframe.className = 'vsfy-frame';
		iframe.src = YT_ORIGIN + '/embed/' + encodeURIComponent( id ) + '?autoplay=1&rel=0&playsinline=1&enablejsapi=1&origin=' + origin + extra;
		iframe.title = title || 'YouTube';
		iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
		iframe.allowFullscreen = true;
		iframe.referrerPolicy = 'strict-origin-when-cross-origin';

		if ( onEnd ) {
			var pid = ++playerId;
			endHandlers = endHandlers.filter( function ( h ) { return document.contains( h.frame ); } );
			endHandlers.push( { frame: iframe, done: onEnd } );
			iframe.addEventListener( 'load', function () {
				var send = function ( msg ) {
					if ( iframe.contentWindow ) {
						iframe.contentWindow.postMessage( JSON.stringify( msg ), YT_ORIGIN );
					}
				};
				send( { event: 'listening', id: pid, channel: 'widget' } );
				send( { event: 'command', func: 'addEventListener', args: [ 'onStateChange' ], id: pid, channel: 'widget' } );
				if ( ! muted ) {
					watchStart( iframe, send );
				}
			} );
		}
		return iframe;
	}

	function embed( root, media, onEnd ) {
		var facade = media.querySelector( '[data-vsfy-facade]:not(.vsfy-leaving)' );
		if ( facades && facade && ! facades.has( media ) ) {
			facades.set( media, facade );
		}
		var id = media.getAttribute( 'data-video' );
		// A one-off start (a chapter clicked before playback) beats the video's own start time.
		var start = +media.getAttribute( 'data-start-once' ) || +media.getAttribute( 'data-start' ) || 0;
		media.removeAttribute( 'data-start-once' );
		var iframe = makeIframe( id, media.getAttribute( 'data-title' ), function () {
			var replay = function () {
				reset( media );
				play( root, media, onEnd );
			};
			if ( ended( root, id, media, replay, onEnd && onEnd.next ? onEnd.next : null ) && onEnd ) {
				onEnd();
			}
		}, start, root );
		media.classList.add( 'is-playing', 'is-loading' );
		media.appendChild( iframe );
		whenReady( iframe, function () {
			media.classList.remove( 'is-loading' );
			// The thumbnail must not stay focusable behind the player.
			setTimeout( function () {
				if ( facades && facade && facade.parentNode === media && iframe.parentNode === media ) {
					media.removeChild( facade );
				}
			}, 400 );
		} );
		root.classList.add( 'is-playing-now' );
		emit( root, media.getAttribute( 'data-video' ), 'inline', media );
	}

	// Fires 'vsfy:end' on root, detail { id, host, replay(), next() }; next is null on the last video. preventDefault()
	// stops the plugin from moving on, e.g. to show an end card. Returns whether it may move on.
	function ended( root, id, host, replay, next ) {
		if ( typeof CustomEvent !== 'function' ) {
			return true;
		}
		var e = new CustomEvent( 'vsfy:end', { bubbles: true, cancelable: true, detail: { id: id, host: host, replay: replay, next: next } } );
		root.dispatchEvent( e );
		return ! e.defaultPrevented;
	}

	function upNext( root, host, next, go ) {
		var old = host.querySelector( '.vsfy-next' );
		detach( old );
		var card = document.createElement( 'div' );
		card.className = 'vsfy-next';
		card.setAttribute( 'role', 'status' );
		card.innerHTML =
			'<span class="vsfy-next-ring"><svg viewBox="0 0 40 40" aria-hidden="true" focusable="false"><circle cx="20" cy="20" r="18" pathLength="100"/><circle class="vsfy-next-bar" cx="20" cy="20" r="18" pathLength="100"/></svg>' +
			'<svg class="vsfy-next-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.67 4.5v15l13-7.5z"/></svg></span>' +
			'<span class="vsfy-next-text"><span class="vsfy-next-label"></span><span class="vsfy-next-title"></span></span>' +
			'<button type="button" class="vsfy-next-now"></button><button type="button" class="vsfy-next-cancel"></button>';
		card.querySelector( '.vsfy-next-label' ).textContent = root.getAttribute( 'data-label-upnext' ) || 'Up next';
		card.querySelector( '.vsfy-next-title' ).textContent = next.title || '';
		var now = card.querySelector( '.vsfy-next-now' );
		var cancel = card.querySelector( '.vsfy-next-cancel' );
		now.textContent = root.getAttribute( 'data-label-now' ) || 'Play now';
		cancel.textContent = root.getAttribute( 'data-label-cancel' ) || 'Cancel';
		if ( next.thumb ) {
			card.style.setProperty( '--vsfy-next-thumb', 'url("' + next.thumb.replace( /["\\]/g, '' ) + '")' );
		}

		var timer = setTimeout( function () {
			// Skip if something else was picked meanwhile (the card left with its video).
			if ( document.contains( card ) && ! card.closest( '.vsfy-leaving, .is-leaving' ) ) {
				detach( card );
				go();
			}
		}, 5000 );
		var leave = function ( start ) {
			clearTimeout( timer );
			after( animate( card, [ { opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' } ], { duration: 200, easing: EASE } ), function () {
				detach( card );
			} );
			if ( start ) {
				go();
			}
		};
		now.addEventListener( 'click', function ( e ) {
			e.stopPropagation();
			leave( true );
		} );
		cancel.addEventListener( 'click', function ( e ) {
			e.stopPropagation();
			leave( false );
		} );
		host.appendChild( card );
	}

	// Fires 'vsfy:play' on root: root.addEventListener( 'vsfy:play', e => e.detail.id ).
	function emit( root, id, mode, media ) {
		if ( typeof CustomEvent !== 'function' ) {
			return;
		}
		root.dispatchEvent( new CustomEvent( 'vsfy:play', { bubbles: true, detail: { id: id, mode: mode, media: media || null } } ) );
	}

	function reset( media ) {
		if ( ! media.classList.contains( 'is-playing' ) && ! media.querySelector( '.vsfy-consent' ) ) {
			return;
		}
		var facade = facades && facades.get( media );
		media.innerHTML = '';
		if ( facade ) {
			media.appendChild( facade );
		}
		media.classList.remove( 'is-playing', 'is-loading' );
	}

	function askConsent( root, box, done ) {
		if ( box.querySelector( '.vsfy-consent' ) ) {
			return;
		}
		var wrap = document.createElement( 'div' );
		wrap.className = 'vsfy-consent';

		var text = document.createElement( 'p' );
		text.textContent = root.getAttribute( 'data-consent-text' ) || '';
		wrap.appendChild( text );

		var ok = document.createElement( 'button' );
		ok.type = 'button';
		ok.className = 'vsfy-consent-ok';
		ok.textContent = root.getAttribute( 'data-consent-button' ) || 'Play';
		wrap.appendChild( ok );

		// With a cookie banner the lasting choice belongs there; the notice only unlocks this video.
		var rememberLabel = bannerConsent() === null ? root.getAttribute( 'data-consent-remember' ) : '';
		var check = null;
		if ( rememberLabel ) {
			var label = document.createElement( 'label' );
			check = document.createElement( 'input' );
			check.type = 'checkbox';
			label.appendChild( check );
			label.appendChild( document.createTextNode( ' ' + rememberLabel ) );
			wrap.appendChild( label );
		}

		ok.addEventListener( 'click', function ( e ) {
			e.stopPropagation();
			if ( check && check.checked ) {
				rememberConsent();
			}
			consentedThisPage = true;
			wrap.parentNode.removeChild( wrap );
			done();
		} );

		box.appendChild( wrap );
		ok.focus();
	}

	function needsConsent( root ) {
		if ( consentedThisPage ) {
			return false;
		}
		// The cookie banner's choice wins over the gallery's setting, in both directions.
		var banner = root.getAttribute( 'data-consent-banner' ) === '1' ? bannerConsent() : null;
		if ( banner !== null ) {
			return ! banner;
		}
		return root.getAttribute( 'data-consent' ) === 'ask' && ! hasConsent();
	}

	function play( root, media, onEnd ) {
		if ( media.classList.contains( 'is-playing' ) ) {
			return;
		}
		var go = function () {
			embed( root, media, onEnd );
		};
		if ( needsConsent( root ) ) {
			askConsent( root, media, go );
		} else {
			go();
		}
	}

	// Lightbox

	// FLIP: animates el from another element's box (a card) to its own, or back.
	function flight( el, from, back ) {
		if ( ! from || ! from.width || calm() ) {
			return null;
		}
		var to = el.getBoundingClientRect();
		if ( ! to.width || ! to.height ) {
			return null;
		}
		var sx = from.width / to.width;
		var sy = from.height / to.height;
		// Different aspect ratios (a Shorts card into the 16:9 frame) would distort, so scale evenly and fade instead.
		var even = Math.abs( sx / sy - 1 ) > 0.15;
		if ( even ) {
			sx = sy = Math.min( sx, sy );
		}
		var dx = from.left + from.width / 2 - ( to.left + to.width / 2 );
		var dy = from.top + from.height / 2 - ( to.top + to.height / 2 );
		var there = { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')', opacity: even ? 0 : 1 };
		var here = { transform: 'none', opacity: 1 };
		return animate( el, back ? [ here, there ] : [ there, here ], { duration: back ? 340 : 440, easing: EASE, fill: 'both' } );
	}

	function onScreen( el ) {
		if ( ! el || ! document.contains( el ) ) {
			return null;
		}
		var r = el.getBoundingClientRect();
		var h = window.innerHeight || document.documentElement.clientHeight;
		var w = window.innerWidth || document.documentElement.clientWidth;
		return r.width && r.bottom > 0 && r.top < h && r.right > 0 && r.left < w ? r : null;
	}

	// opts (all optional): portrait, className, onShow( index, box ), onEnd( index, api ) instead of "Up next",
	// onClose(). Public as DevenziVideo.lightbox(); returns { show, close, box }.
	function openLightbox( root, list, start, opts ) {
		opts = opts || {};
		var index = start;
		var lastFocus = document.activeElement;
		var autonext = root.getAttribute( 'data-autonext' ) === '1';
		var closing = false;
		var slide = null;

		var box = document.createElement( 'div' );
		box.className = 'vsfy-lightbox' + ( opts.portrait ? ' vsfy-lightbox--portrait' : '' ) + ( opts.className ? ' ' + opts.className : '' );
		box.setAttribute( 'role', 'dialog' );
		box.setAttribute( 'aria-modal', 'true' );
		box.style.setProperty( '--vsfy-accent', getComputedStyle( root ).getPropertyValue( '--vsfy-accent' ) );
		box.innerHTML =
			'<div class="vsfy-lb-frame"></div><p class="vsfy-lb-title"></p>' +
			'<button type="button" class="vsfy-lb-close">' + svg( 'M5 5l10 10M15 5L5 15' ) + '</button>' +
			( list.length > 1
				? '<button type="button" class="vsfy-lb-nav vsfy-lb-prev">' + svg( 'M12.5 4.5 7 10l5.5 5.5' ) + '</button>' +
				'<button type="button" class="vsfy-lb-nav vsfy-lb-next">' + svg( 'M7.5 4.5 13 10l-5.5 5.5' ) + '</button>'
				: '' );

		var frame = box.querySelector( '.vsfy-lb-frame' );
		var titleEl = box.querySelector( '.vsfy-lb-title' );
		var closeBtn = box.querySelector( '.vsfy-lb-close' );
		closeBtn.setAttribute( 'aria-label', root.getAttribute( 'data-label-close' ) || 'Close' );
		var prev = box.querySelector( '.vsfy-lb-prev' );
		var next = box.querySelector( '.vsfy-lb-next' );
		if ( prev ) {
			prev.setAttribute( 'aria-label', root.getAttribute( 'data-label-prev' ) || 'Previous' );
			next.setAttribute( 'aria-label', root.getAttribute( 'data-label-next' ) || 'Next' );
		}

		// dir: 1 = forward, -1 = back, 0 = no slide (first video).
		function show( i, dir ) {
			index = ( i + list.length ) % list.length;
			var v = list[ index ];
			var old = slide;
			slide = document.createElement( 'div' );
			slide.className = 'vsfy-lb-slide';
			if ( v.thumb ) {
				var img = document.createElement( 'img' );
				img.src = v.thumb;
				img.alt = '';
				slide.appendChild( img );
			}
			frame.appendChild( slide );

			if ( old ) {
				pauseFrame( old.querySelector( 'iframe' ) );
				old.classList.add( 'is-leaving' );
				var shift = ( dir || 1 ) * 22;
				after( animate( old, [ { transform: 'none', opacity: 1 }, { transform: 'translateX(' + -shift + '%)', opacity: 0 } ], { duration: 420, easing: EASE } ), function () {
					detach( old );
				} );
				animate( slide, [ { transform: 'translateX(' + shift + '%)', opacity: 0 }, { transform: 'none', opacity: 1 } ], { duration: 420, easing: EASE } );
				freshen( titleEl );
			}
			titleEl.textContent = v.title;
			box.setAttribute( 'aria-label', v.title || 'YouTube' );

			var host = slide;
			var go = function () {
				if ( closing || host !== slide ) {
					return;
				}
				var done = function () {
					if ( host !== slide || closing ) {
						return;
					}
					var replay = function () {
						detach( host.querySelector( 'iframe' ) );
						go();
					};
					var nextOne = list.length > 1 ? function () { show( index + 1, 1 ); } : null;
					if ( ! ended( root, v.id, host, replay, nextOne ) ) {
						return;
					}
					if ( opts.onEnd ) {
						opts.onEnd( index, api );
					} else if ( autonext && nextOne ) {
						upNext( root, host, list[ ( index + 1 ) % list.length ], nextOne );
					}
				};
				var iframe = makeIframe( v.id, v.title, done, v.start, root );
				host.classList.add( 'is-loading' );
				host.appendChild( iframe );
				whenReady( iframe, function () { host.classList.remove( 'is-loading' ); } );
				emit( root, v.id, 'lightbox', frame );
			};
			if ( needsConsent( root ) ) {
				askConsent( root, host, go );
			} else {
				go();
			}
			if ( opts.onShow ) {
				opts.onShow( index, box );
			}
		}

		function close() {
			if ( closing ) {
				return;
			}
			closing = true;
			document.removeEventListener( 'keydown', onKey );
			Array.prototype.forEach.call( frame.querySelectorAll( 'iframe, .vsfy-consent, .vsfy-next' ), detach );
			var home = onScreen( list[ index ].home );
			var fly = flight( frame, home, true ) ||
				animate( frame, [ { transform: 'none', opacity: 1 }, { transform: 'scale(.96)', opacity: 0 } ], { duration: 220, easing: 'ease-in', fill: 'both' } );
			var fade = animate( box, [ { opacity: 1 }, { opacity: 1, offset: home ? 0.55 : 0 }, { opacity: 0 } ], { duration: home ? 360 : 240, easing: 'ease-out', fill: 'both' } );
			after( fade || fly, function () {
				detach( box );
				document.documentElement.classList.remove( 'vsfy-lb-open' );
			} );
			if ( opts.onClose ) {
				opts.onClose();
			}
			if ( lastFocus && lastFocus.focus ) {
				lastFocus.focus( { preventScroll: true } );
			}
		}

		function onKey( e ) {
			if ( e.key === 'Escape' ) {
				close();
			} else if ( e.key === 'ArrowRight' && list.length > 1 ) {
				show( index + 1, 1 );
			} else if ( e.key === 'ArrowLeft' && list.length > 1 ) {
				show( index - 1, -1 );
			} else if ( e.key === 'Tab' ) {
				var items = box.querySelectorAll( 'button, input, iframe' );
				var first = items[ 0 ];
				var last = items[ items.length - 1 ];
				if ( e.shiftKey && document.activeElement === first ) {
					e.preventDefault();
					last.focus();
				} else if ( ! e.shiftKey && document.activeElement === last ) {
					e.preventDefault();
					first.focus();
				}
			}
		}

		closeBtn.addEventListener( 'click', close );
		if ( prev ) {
			prev.addEventListener( 'click', function () { show( index - 1, -1 ); } );
			next.addEventListener( 'click', function () { show( index + 1, 1 ); } );

			swipe( box, function ( dir ) {
				show( index + dir, dir );
			} );
		}
		box.addEventListener( 'click', function ( e ) {
			if ( e.target === box ) {
				close();
			}
		} );
		document.addEventListener( 'keydown', onKey );

		var api = { show: function ( i ) { show( i, i > index ? 1 : -1 ); }, close: close, box: box };
		document.body.appendChild( box );
		document.documentElement.classList.add( 'vsfy-lb-open' );
		show( index, 0 );
		if ( flight( frame, onScreen( list[ index ].home ), false ) ) {
			frame.classList.add( 'is-flying' );
		}
		closeBtn.focus( { preventScroll: true } );
		return api;
	}

	function lightboxList( root, stage ) {
		var nodes = root.querySelectorAll( '[data-vsfy-item], [data-vsfy-card] [data-vsfy-player]' );
		return Array.prototype.map.call( nodes, function ( el ) {
			return {
				id: el.getAttribute( 'data-video' ),
				start: +el.getAttribute( 'data-start' ) || 0,
				title: el.getAttribute( 'data-title' ) || '',
				thumb: thumbOf( el ),
				home: stage || el,
			};
		} );
	}

	// Slider
	function setupSlider( root ) {
		var track = root.querySelector( '[data-vsfy-track]' );
		var prev = root.querySelector( '[data-vsfy-prev]' );
		var next = root.querySelector( '[data-vsfy-next]' );
		var dots = root.querySelector( '[data-vsfy-dots]' );
		var pages = 0;
		if ( ! track ) {
			return;
		}

		// Cards hidden by a filter (Pro search) do not count.
		function shown() {
			return Array.prototype.filter.call( track.children, function ( c ) { return ! c.hidden; } );
		}

		function step() {
			var card = shown()[ 0 ];
			var gap = parseFloat( getComputedStyle( track ).columnGap ) || 0;
			return card ? card.getBoundingClientRect().width + gap : track.clientWidth;
		}

		function perView() {
			var gap = parseFloat( getComputedStyle( track ).columnGap ) || 0;
			return Math.max( 1, Math.floor( ( track.clientWidth + gap ) / step() ) );
		}

		function buildDots() {
			var count = Math.max( 1, Math.ceil( shown().length / perView() ) );
			if ( ! dots || count === pages ) {
				return;
			}
			pages = count;
			dots.innerHTML = '';
			for ( var i = 0; i < count; i++ ) {
				var b = document.createElement( 'button' );
				b.type = 'button';
				b.tabIndex = -1;
				b.setAttribute( 'data-page', i );
				dots.appendChild( b );
			}
			// Alternative progress displays ("2 / 8" and a bar); the gallery's class decides which one shows.
			var num = document.createElement( 'span' );
			num.className = 'vsfy-count';
			dots.appendChild( num );
			var bar = document.createElement( 'span' );
			bar.className = 'vsfy-bar';
			bar.appendChild( document.createElement( 'i' ) );
			dots.appendChild( bar );
		}

		function arrowHeight() {
			var media = track.querySelector( '.vsfy-media, .vsfy-thumb, img' );
			if ( ! media || ! root.classList.contains( 'vsfy--nav-sides' ) ) {
				return;
			}
			var r = root.getBoundingClientRect();
			var m = media.getBoundingClientRect();
			root.style.setProperty( '--vsfy-arrow-y', Math.round( m.top - r.top + m.height / 2 ) + 'px' );
		}

		function update() {
			var max = track.scrollWidth - track.clientWidth;
			var isStatic = max <= 2;
			root.classList.toggle( 'is-static', isStatic );
			buildDots();
			if ( dots ) {
				var current = track.scrollLeft >= max - 2 ? pages - 1 : Math.round( track.scrollLeft / ( step() * perView() ) );
				if ( ! isFinite( current ) || current < 0 ) {
					current = 0;
				}
				Array.prototype.forEach.call( dots.querySelectorAll( 'button' ), function ( d, i ) {
					d.classList.toggle( 'is-active', i === current );
				} );
				var num = dots.querySelector( '.vsfy-count' );
				if ( num ) {
					num.innerHTML = '<b>' + ( current + 1 ) + '</b> / ' + pages;
				}
				root.style.setProperty( '--vsfy-progress', Math.round( ( ( current + 1 ) / pages ) * 100 ) + '%' );
			}
			arrowHeight();
		}

		function page( dir ) {
			var max = track.scrollWidth - track.clientWidth;
			if ( dir > 0 && track.scrollLeft >= max - 2 ) {
				track.scrollTo( { left: 0, behavior: 'smooth' } );
			} else if ( dir < 0 && track.scrollLeft <= 2 ) {
				track.scrollTo( { left: max, behavior: 'smooth' } );
			} else {
				track.scrollBy( { left: dir * step() * perView(), behavior: 'smooth' } );
			}
		}

		if ( prev ) {
			prev.addEventListener( 'click', function () { page( -1 ); } );
		}
		if ( next ) {
			next.addEventListener( 'click', function () { page( 1 ); } );
		}
		if ( dots ) {
			dots.addEventListener( 'click', function ( e ) {
				var b = e.target.closest( '[data-page]' );
				if ( b ) {
					track.scrollTo( { left: +b.getAttribute( 'data-page' ) * step() * perView(), behavior: 'smooth' } );
				}
			} );
		}
		track.addEventListener( 'keydown', function ( e ) {
			if ( e.target !== track ) {
				return;
			}
			if ( e.key === 'ArrowRight' ) {
				e.preventDefault();
				page( 1 );
			} else if ( e.key === 'ArrowLeft' ) {
				e.preventDefault();
				page( -1 );
			} else if ( e.key === 'Home' || e.key === 'End' ) {
				e.preventDefault();
				track.scrollTo( { left: e.key === 'Home' ? 0 : track.scrollWidth, behavior: 'smooth' } );
			}
		} );

		var raf = 0;
		track.addEventListener( 'scroll', function () {
			cancelAnimationFrame( raf );
			raf = requestAnimationFrame( update );
		}, { passive: true } );

		if ( typeof ResizeObserver === 'function' ) {
			new ResizeObserver( function () {
				pages = 0;
				update();
			} ).observe( track );
		} else {
			window.addEventListener( 'resize', update );
		}
		update();

		// Auto-advance every 4 s, paused on hover, focus, playback or off screen. The explicit stop button is
		// required for phones and screen readers (WCAG 2.2.2).
		if ( root.getAttribute( 'data-autoplay' ) === '1' && ! window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches ) {
			var paused = false;
			var stopped = false;
			var visible = true;
			var toggle = root.querySelector( '[data-vsfy-autoplay]' );
			if ( toggle ) {
				toggle.hidden = false;
				toggle.addEventListener( 'click', function () {
					stopped = ! stopped;
					toggle.setAttribute( 'aria-pressed', stopped ? 'true' : 'false' );
					toggle.setAttribute( 'aria-label', toggle.getAttribute( stopped ? 'data-label-play' : 'data-label-pause' ) );
					toggle.querySelector( 'path' ).setAttribute( 'd', stopped ? 'M7 5l8 5-8 5z' : 'M7.5 5v10M12.5 5v10' );
				} );
			}
			// Pausing freezes the remaining time instead of restarting it; the ring on the pause button shows it.
			var DELAY = 4000;
			var left = DELAY;
			var since = 0;
			var timer = 0;
			var ring = null;
			if ( toggle ) {
				toggle.insertAdjacentHTML( 'beforeend', '<svg class="vsfy-ring" viewBox="0 0 42 42" aria-hidden="true" focusable="false"><circle cx="21" cy="21" r="20" pathLength="100"/></svg>' );
				ring = toggle.querySelector( '.vsfy-ring circle' );
			}
			var running = function () {
				return ! stopped && ! paused && visible && ! document.hidden && ! root.querySelector( '.is-playing' );
			};
			var sync = function () {
				var on = running();
				root.classList.toggle( 'is-auto-paused', ! on );
				root.classList.toggle( 'is-auto-stopped', stopped );
				if ( on && ! timer ) {
					since = Date.now();
					timer = setTimeout( tick, left );
				} else if ( ! on && timer ) {
					clearTimeout( timer );
					timer = 0;
					left = Math.max( 0, left - ( Date.now() - since ) );
				}
			};
			var tick = function () {
				timer = 0;
				left = DELAY;
				var max = track.scrollWidth - track.clientWidth;
				track.scrollTo( { left: track.scrollLeft >= max - 2 ? 0 : track.scrollLeft + step(), behavior: 'smooth' } );
				if ( ring ) {
					// Reflow so the ring animation restarts from empty.
					ring.style.animation = 'none';
					void ring.getBoundingClientRect();
					ring.style.animation = '';
				}
				sync();
			};
			var pause = function () { paused = true; sync(); };
			var resume = function () { paused = false; sync(); };
			if ( toggle ) {
				toggle.addEventListener( 'click', sync );
			}
			root.addEventListener( 'mouseenter', pause );
			root.addEventListener( 'mouseleave', resume );
			root.addEventListener( 'focusin', pause );
			root.addEventListener( 'focusout', resume );
			root.addEventListener( 'vsfy:play', sync );
			document.addEventListener( 'visibilitychange', sync );
			if ( typeof IntersectionObserver === 'function' ) {
				new IntersectionObserver( function ( entries ) {
					visible = entries[ 0 ].isIntersecting;
					sync();
				} ).observe( root );
			}
			setInterval( sync, 1000 ); // catches videos stopped from outside (tabs, mini player)
			sync();
		}
	}

	function setupCards( root ) {
		var medias = Array.prototype.slice.call( root.querySelectorAll( '[data-vsfy-player]' ) );
		var lightbox = root.getAttribute( 'data-open' ) === 'lightbox';
		// The compact list opens videos in place: a 150 px thumbnail is too small to watch.
		var open = root.getAttribute( 'data-open' );
		var stage = open === 'stage' || ( root.getAttribute( 'data-vsfy' ) === 'list' && open !== 'lightbox' ) ? setupStage( root ) : null;
		setupSort( root, stage );
		medias.forEach( function ( media, n ) {
			media.addEventListener( 'click', function ( e ) {
				if ( ! e.target.closest( '[data-vsfy-facade]' ) ) {
					return;
				}
				if ( lightbox ) {
					openLightbox( root, lightboxList( root ), n, { portrait: root.classList.contains( 'vsfy--portrait' ) } );
					return;
				}
				if ( stage && stage.open( media.closest( '[data-vsfy-card]' ) ) ) {
					return;
				}
				medias.forEach( function ( other ) {
					if ( other !== media ) {
						reset( other );
					}
				} );
				play( root, media );
			} );
		} );
	}

	function setupSort( root, stage ) {
		var rows = root.querySelector( '.vsfy-rows' );
		var buttons = Array.prototype.slice.call( root.querySelectorAll( '[data-vsfy-sort]' ) );
		if ( ! rows || ! buttons.length ) {
			return;
		}
		buttons.forEach( function ( b ) {
			b.addEventListener( 'click', function () {
				var old = b.getAttribute( 'data-vsfy-sort' ) === 'old';
				if ( stage ) {
					stage.close();
				}
				buttons.forEach( function ( o ) {
					o.setAttribute( 'aria-pressed', o === b ? 'true' : 'false' );
				} );
				var cards = Array.prototype.slice.call( rows.querySelectorAll( ':scope > [data-vsfy-card]' ) );
				cards.sort( function ( x, y ) {
					var d = +x.getAttribute( 'data-published' ) - +y.getAttribute( 'data-published' );
					return old ? d : -d;
				} );
				cards.forEach( function ( c ) {
					rows.appendChild( c );
				} );
				freshen( rows );
			} );
		} );
	}

	// Grid stage: the video opens large below its row
	function setupStage( root ) {
		var grid = root.querySelector( '.vsfy-grid, .vsfy-shorts, .vsfy-rows' );
		if ( ! grid ) {
			return null;
		}
		var box = null; // The stage: { el, media, card }.

		function cards() {
			return Array.prototype.filter.call( grid.querySelectorAll( ':scope > [data-vsfy-card]' ), function ( c ) { return ! c.hidden; } );
		}

		// Last card in the given card's row; a card spanning two rows covers both.
		function rowEnd( card ) {
			var bottom = card.offsetTop + card.offsetHeight;
			var end = card;
			cards().forEach( function ( c ) {
				if ( c.offsetTop < bottom && ( end.compareDocumentPosition( c ) & 4 ) ) {
					end = c;
				}
			} );
			return end;
		}

		function build() {
			var el = document.createElement( 'div' );
			el.className = 'vsfy-bigstage';
			el.setAttribute( 'role', 'region' );
			el.innerHTML =
				'<div class="vsfy-bigstage-in"><div class="vsfy-media" data-vsfy-player></div>' +
				'<div class="vsfy-bigstage-bar"><div class="vsfy-bigstage-text"><p class="vsfy-bigstage-title"></p><p class="vsfy-meta"><span class="vsfy-bigstage-date"></span><a target="_blank" rel="noopener"></a></p></div>' +
				'<button type="button" class="vsfy-arrow" data-dir="-1">' + svg( 'M12.5 4.5 7 10l5.5 5.5' ) + '</button>' +
				'<button type="button" class="vsfy-arrow" data-dir="1">' + svg( 'M7.5 4.5 13 10l-5.5 5.5' ) + '</button>' +
				'<button type="button" class="vsfy-arrow vsfy-bigstage-close">' + svg( 'M5 5l10 10M15 5L5 15' ) + '</button></div></div>';
			var b = el.querySelectorAll( 'button' );
			b[ 0 ].setAttribute( 'aria-label', root.getAttribute( 'data-label-prev' ) || 'Previous' );
			b[ 1 ].setAttribute( 'aria-label', root.getAttribute( 'data-label-next' ) || 'Next' );
			b[ 2 ].setAttribute( 'aria-label', root.getAttribute( 'data-label-close' ) || 'Close' );
			el.querySelector( '.vsfy-meta a' ).textContent = ( root.getAttribute( 'data-label-youtube' ) || 'YouTube' ) + '\u00a0\u2197';
			b[ 0 ].addEventListener( 'click', function () { step( -1 ); } );
			b[ 1 ].addEventListener( 'click', function () { step( 1 ); } );
			b[ 2 ].addEventListener( 'click', close );
			el.addEventListener( 'keydown', function ( e ) {
				if ( e.key === 'Escape' ) {
					close();
				} else if ( ( e.key === 'ArrowLeft' || e.key === 'ArrowRight' ) && ! e.target.closest( 'input, textarea' ) ) {
					e.preventDefault();
					step( e.key === 'ArrowRight' ? 1 : -1 );
				}
			} );
			swipe( el.querySelector( '[data-vsfy-player]' ), function ( dir ) {
				step( dir );
			} );
			var media = el.querySelector( '[data-vsfy-player]' );
			media.addEventListener( 'click', function ( e ) {
				if ( e.target.closest( '[data-vsfy-facade]' ) ) {
					play( root, media );
				}
			} );
			return { el: el, media: media, card: null };
		}

		function fill( card ) {
			var src = card.querySelector( '[data-vsfy-player]' );
			var id = src.getAttribute( 'data-video' );
			var title = src.getAttribute( 'data-title' ) || '';
			var meta = card.querySelector( '.vsfy-card-meta' );
			if ( box.card ) {
				box.card.classList.remove( 'is-on-stage' );
			}
			box.card = card;
			card.classList.add( 'is-on-stage' );
			reset( box.media );
			box.media.innerHTML = '';
			var facade = src.querySelector( '[data-vsfy-facade]' ).cloneNode( true );
			var img = facade.querySelector( 'img' );
			if ( img ) {
				img.setAttribute( 'sizes', '(max-width: 900px) 100vw, 1100px' );
				img.setAttribute( 'loading', 'eager' );
			}
			box.media.appendChild( facade );
			if ( facades ) {
				facades.set( box.media, facade );
			}
			box.media.setAttribute( 'data-video', id );
			box.media.setAttribute( 'data-title', title );
			if ( src.getAttribute( 'data-start' ) ) {
				box.media.setAttribute( 'data-start', src.getAttribute( 'data-start' ) );
			} else {
				box.media.removeAttribute( 'data-start' );
			}
			box.el.setAttribute( 'aria-label', title || 'YouTube' );
			box.el.querySelector( '.vsfy-bigstage-title' ).textContent = title;
			box.el.querySelector( '.vsfy-bigstage-date' ).textContent = meta ? meta.textContent : '';
			box.el.querySelector( '.vsfy-meta a' ).href = 'https://www.youtube.com/watch?v=' + encodeURIComponent( id );
			freshen( box.el.querySelector( '.vsfy-bigstage-bar' ) );
		}

		function place( card ) {
			var end = rowEnd( card );
			if ( end.nextElementSibling !== box.el ) {
				end.parentNode.insertBefore( box.el, end.nextElementSibling );
			}
		}

		function reveal( card ) {
			var h = box.el.offsetHeight;
			animate( box.el, [ { height: '0px', opacity: 0 }, { height: h + 'px', opacity: 1 } ], { duration: 420, easing: EASE } );
			flight( box.media, onScreen( card.querySelector( '[data-vsfy-player]' ) ), false );
			setTimeout( function () {
				var r = box.el.getBoundingClientRect();
				if ( r.bottom > window.innerHeight || r.top < 0 ) {
					box.el.scrollIntoView( { behavior: calm() ? 'auto' : 'smooth', block: 'nearest' } );
				}
			}, 440 );
		}

		function open( card ) {
			// Horizontally scrolling rows (Shorts on phones) have no room below: play in place.
			if ( ! card || getComputedStyle( grid ).gridAutoFlow.indexOf( 'column' ) !== -1 ) {
				return false;
			}
			cards().forEach( function ( c ) {
				reset( c.querySelector( '[data-vsfy-player]' ) );
			} );
			var fresh = ! box || ! box.el.parentNode;
			var was = fresh ? 0 : box.el.offsetTop;
			box = box || build();
			fill( card );
			place( card );
			// A card in the same row (or block, beside a large lead video) keeps the stage where it is.
			if ( fresh || Math.abs( box.el.offsetTop - was ) > 2 ) {
				reveal( card );
			}
			play( root, box.media );
			return true;
		}

		function step( dir ) {
			var list = cards();
			var i = list.indexOf( box.card );
			if ( i !== -1 ) {
				open( list[ ( i + dir + list.length ) % list.length ] );
			}
		}

		function close() {
			if ( ! box || ! box.el.parentNode ) {
				return;
			}
			var card = box.card;
			var el = box.el;
			reset( box.media );
			box.media.innerHTML = '';
			card.classList.remove( 'is-on-stage' );
			after( animate( el, [ { height: el.offsetHeight + 'px', opacity: 1 }, { height: '0px', opacity: 0 } ], { duration: 320, easing: EASE } ), function () {
				detach( el );
			} );
			var f = card.querySelector( '[data-vsfy-facade]' );
			if ( f ) {
				f.focus( { preventScroll: true } );
			}
		}

		if ( typeof ResizeObserver === 'function' ) {
			new ResizeObserver( function () {
				if ( box && box.el.parentNode && box.card ) {
					place( box.card );
				}
			} ).observe( grid );
		}
		return { open: open, close: close };
	}

	// Playlist player
	function setupPlayer( root ) {
		var media = root.querySelector( '[data-vsfy-player]' );
		var list = root.querySelector( '.vsfy-list' );
		var items = Array.prototype.slice.call( root.querySelectorAll( '[data-vsfy-item]' ) );
		var titleEl = root.querySelector( '[data-vsfy-title]' );
		var descEl = root.querySelector( '[data-vsfy-desc]' );
		if ( descEl ) {
			setupDesc( descEl );
		}
		var dateEl = root.querySelector( '[data-vsfy-date]' );
		var linkEl = root.querySelector( '[data-vsfy-link]' );
		var ambient = root.querySelector( '[data-vsfy-ambient]' );
		var lightbox = root.getAttribute( 'data-open' ) === 'lightbox';
		var autonext = root.getAttribute( 'data-autonext' ) === '1' && items.length > 1;
		var index = 0;
		if ( ! media ) {
			return;
		}

		function onEnd() {
			if ( ! autonext ) {
				return;
			}
			var next = items[ ( index + 1 ) % items.length ];
			upNext( root, media, { title: next.getAttribute( 'data-title' ) || '', thumb: thumbOf( next ) }, function () {
				show( index + 1 );
				play( root, media, onEnd );
			} );
		}

		onEnd.next = items.length > 1 ? function () {
			show( index + 1 );
			play( root, media, onEnd );
		} : null;

		media.addEventListener( 'click', function ( e ) {
			if ( ! e.target.closest( '[data-vsfy-facade]' ) ) {
				return;
			}
			if ( lightbox ) {
				openLightbox( root, items.length ? lightboxList( root, media ) : [ { id: media.getAttribute( 'data-video' ), title: media.getAttribute( 'data-title' ) || '', thumb: thumbOf( media ), home: media } ], index );
				return;
			}
			play( root, media, onEnd );
		} );

		// Theater mode is a class toggle only: moving the iframe in the DOM would reload it and stop playback.
		var theater = root.querySelector( '[data-vsfy-theater]' );
		var stageEl = root.querySelector( '.vsfy-stage' );
		if ( theater && stageEl ) {
			theater.addEventListener( 'click', function () {
				var from = stageEl.getBoundingClientRect();
				var on = ! root.classList.contains( 'is-theater' );
				root.classList.toggle( 'is-theater', on );
				theater.setAttribute( 'aria-pressed', on ? 'true' : 'false' );
				var to = stageEl.getBoundingClientRect();
				if ( to.width ) {
					animate( stageEl, [
						{ transformOrigin: '0 0', transform: 'translate(' + ( from.left - to.left ) + 'px, ' + ( from.top - to.top ) + 'px) scale(' + ( from.width / to.width ) + ')' },
						{ transformOrigin: '0 0', transform: 'none' },
					], { duration: 460, easing: EASE } );
				}
				freshen( root.querySelector( '.vsfy-aside' ) );
				reveal( items[ index ] );
			} );
		}

		if ( items.length > 1 ) {
			swipe( media, function ( dir ) {
				if ( ! media.classList.contains( 'is-playing' ) ) {
					show( index + dir );
				}
			} );
			media.addEventListener( 'keydown', function ( e ) {
				if ( ( e.key === 'ArrowLeft' || e.key === 'ArrowRight' ) && e.target.closest( '[data-vsfy-facade]' ) ) {
					e.preventDefault();
					show( index + ( e.key === 'ArrowRight' ? 1 : -1 ) );
					var f = media.querySelector( '[data-vsfy-facade]:not(.vsfy-leaving)' );
					if ( f ) {
						f.focus( { preventScroll: true } );
					}
				}
			} );
		}

		// Scroll only the list, never the page.
		function reveal( el ) {
			if ( ! list || ! el ) {
				return;
			}
			var l = list.getBoundingClientRect();
			var r = el.getBoundingClientRect();
			if ( getComputedStyle( list ).flexDirection === 'column' ) {
				if ( r.top < l.top || r.bottom > l.bottom ) {
					list.scrollTo( { top: list.scrollTop + ( r.top - l.top ) - 8, behavior: 'smooth' } );
				}
			} else if ( r.left < l.left || r.right > l.right ) {
				list.scrollTo( { left: list.scrollLeft + ( r.left - l.left ) - ( l.width - r.width ) / 2, behavior: 'smooth' } );
			}
		}

		function glow( src ) {
			var current = ambient && ambient.querySelector( 'img:last-child' );
			if ( ! current || ! src || current.getAttribute( 'src' ) === src ) {
				return;
			}
			if ( calm() ) {
				current.src = src;
				return;
			}
			var img = current.cloneNode( false );
			img.removeAttribute( 'srcset' );
			img.src = src;
			ambient.appendChild( img );
			var done = false;
			var go = function () {
				if ( done ) {
					return;
				}
				done = true;
				after( animate( img, [ { opacity: 0 }, { opacity: 1 } ], { duration: 700, easing: 'ease' } ), function () {
					Array.prototype.forEach.call( ambient.querySelectorAll( 'img' ), function ( el ) {
						if ( el !== img && el !== ambient.lastElementChild ) {
							detach( el );
						}
					} );
				} );
			};
			if ( img.complete ) {
				go();
			} else {
				img.addEventListener( 'load', go );
				img.addEventListener( 'error', go );
			}
		}

		// Cloned from the server-rendered button, so shape and icon follow the design settings.
		var playTpl = root.querySelector( '.vsfy-play' );
		playTpl = playTpl ? playTpl.cloneNode( true ) : null;

		function show( i ) {
			index = ( i + items.length ) % items.length;
			var item = items[ index ];
			var id = item.getAttribute( 'data-video' );
			var title = item.getAttribute( 'data-title' ) || '';

			items.forEach( function ( el, n ) {
				el.classList.toggle( 'is-active', n === index );
				if ( n === index ) {
					el.setAttribute( 'aria-current', 'true' );
				} else {
					el.removeAttribute( 'aria-current' );
				}
			} );

			var thumb = item.querySelector( '.vsfy-item-thumb img, .vsfy-item-thumb .vsfy-ph' );
			var facade = document.createElement( 'button' );
			facade.type = 'button';
			facade.className = 'vsfy-facade';
			facade.setAttribute( 'data-vsfy-facade', '' );
			facade.setAttribute( 'aria-label', ( root.getAttribute( 'data-label-play' ) || 'Play' ) + ( title ? ': ' + title : '' ) );
			if ( thumb ) {
				var copy = thumb.cloneNode( true );
				if ( copy.tagName === 'IMG' ) {
					copy.setAttribute( 'sizes', '(max-width: 900px) 100vw, 860px' );
					copy.setAttribute( 'loading', 'eager' );
					glow( copy.getAttribute( 'src' ) );
				}
				facade.appendChild( copy );
			}
			var playIcon = playTpl ? playTpl.cloneNode( true ) : document.createElement( 'span' );
			if ( ! playTpl ) {
				playIcon.className = 'vsfy-play';
				playIcon.setAttribute( 'aria-hidden', 'true' );
				playIcon.innerHTML = '<svg viewBox="0 0 24 24" focusable="false"><path d="M7.67 4.5v15l13-7.5z"/></svg>';
			}
			facade.appendChild( playIcon );

			if ( facades ) {
				facades.set( media, facade );
			}
			media.setAttribute( 'data-video', id );
			media.setAttribute( 'data-title', title );
			if ( item.getAttribute( 'data-start' ) ) {
				media.setAttribute( 'data-start', item.getAttribute( 'data-start' ) );
			} else {
				media.removeAttribute( 'data-start' );
			}
			media.classList.remove( 'is-playing', 'is-loading' );

			var old = Array.prototype.slice.call( media.children );
			media.appendChild( facade );
			old.forEach( function ( el ) {
				if ( el.tagName === 'IFRAME' ) {
					pauseFrame( el );
				}
				el.classList.add( 'vsfy-leaving' );
			} );
			after( animate( facade, [ { opacity: 0, transform: 'scale(1.035)' }, { opacity: 1, transform: 'none' } ], { duration: 460, easing: EASE } ), function () {
				old.forEach( detach );
			} );

			if ( titleEl ) {
				titleEl.textContent = title;
				titleEl.hidden = ! title;
				freshen( titleEl );
			}
			if ( dateEl ) {
				dateEl.textContent = item.getAttribute( 'data-date' ) || '';
				freshen( dateEl.parentNode );
			}
			if ( descEl ) {
				var desc = item.getAttribute( 'data-desc' ) || '';
				descEl.hidden = ! desc;
				linkify( descEl.querySelector( 'p' ), desc );
				if ( descEl.vsfyFit ) {
					descEl.vsfyFit();
				}
				freshen( descEl );
			}
			if ( linkEl ) {
				linkEl.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent( id );
			}
			reveal( item );
		}

		// Public: 'vsfy:select' with detail { id } shows a video without playing it, e.g. for a deep link.
		root.addEventListener( 'vsfy:select', function ( e ) {
			var id = e.detail && e.detail.id;
			for ( var n = 0; n < items.length; n++ ) {
				if ( items[ n ].getAttribute( 'data-video' ) === id ) {
					if ( n !== index ) {
						show( n );
					}
					return;
				}
			}
		} );

		items.forEach( function ( el, n ) {
			el.addEventListener( 'click', function () {
				if ( lightbox ) {
					show( n );
					openLightbox( root, lightboxList( root, media ), n );
					return;
				}
				if ( n === index && media.classList.contains( 'is-playing' ) ) {
					return;
				}
				show( n );
				play( root, media, onEnd );
			} );
			el.addEventListener( 'keydown', function ( e ) {
				var dir = ( e.key === 'ArrowDown' || e.key === 'ArrowRight' ) ? 1 : ( e.key === 'ArrowUp' || e.key === 'ArrowLeft' ) ? -1 : 0;
				if ( ! dir ) {
					return;
				}
				e.preventDefault();
				var target = items[ ( n + dir + items.length ) % items.length ];
				target.focus();
				reveal( target );
			} );
		} );
	}

	function setup( root ) {
		if ( root.getAttribute( 'data-vsfy-ready' ) ) {
			return;
		}
		root.setAttribute( 'data-vsfy-ready', '1' );

		var layout = root.getAttribute( 'data-vsfy' );
		if ( layout === 'playlist' || layout === 'single' ) {
			setupPlayer( root );
		} else {
			setupCards( root );
			if ( layout === 'slider' ) {
				setupSlider( root );
			}
		}
	}

	function init( scope ) {
		Array.prototype.forEach.call( ( scope || document ).querySelectorAll( '[data-vsfy]' ), setup );
	}

	// Public: resets every playing video inside scope (e.g. a tab being hidden).
	function stop( scope ) {
		Array.prototype.forEach.call( ( scope || document ).querySelectorAll( '[data-vsfy-player].is-playing' ), reset );
	}

	window.DevenziVideo = { init: init, stop: stop, lightbox: openLightbox };

	// One video per page: a starting video pauses (rather than resets) the others, across galleries too.
	document.addEventListener( 'vsfy:play', function ( e ) {
		var here = e.detail && e.detail.media;
		Array.prototype.forEach.call( document.querySelectorAll( 'iframe.vsfy-frame' ), function ( iframe ) {
			if ( ! here || ! here.contains( iframe ) ) {
				pauseFrame( iframe );
			}
		} );
	} );

	// Galleries inserted later (page builder previews, AJAX content) start up on their own.
	function watchNew() {
		if ( typeof MutationObserver !== 'function' || ! document.body ) {
			return;
		}
		var queued = false;
		new MutationObserver( function ( records ) {
			if ( queued ) {
				return;
			}
			var found = records.some( function ( r ) {
				return Array.prototype.some.call( r.addedNodes, function ( n ) {
					return n.nodeType === 1 && ( ( n.matches && n.matches( '[data-vsfy], [data-vsfy-tabs]' ) ) || ( n.querySelector && n.querySelector( '[data-vsfy], [data-vsfy-tabs]' ) ) );
				} );
			} );
			if ( found ) {
				queued = true;
				requestAnimationFrame( function () {
					queued = false;
					window.DevenziVideo.init(); // looked up now, so extensions that wrap init take part
				} );
			}
		} ).observe( document.body, { childList: true, subtree: true } );
	}

	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', function () { init(); watchNew(); } );
	} else {
		init();
		watchNew();
	}
} )();
