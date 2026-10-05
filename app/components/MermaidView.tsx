/**
 * Mermaid rendering in a sandboxed WebView.
 *
 * mermaid.js needs a DOM to lay out and measure text, so there is no way to run
 * it in React Native. This is the one place a WebView is unavoidable — and it is
 * deliberately confined to *rendering*: the editor never runs here, so the
 * "native rich text, no WebView" decision is unaffected. See
 * brain/pages/native-richtext-editor.md.
 *
 * The bridge is one-way: the page reports its rendered height back so the
 * container can size itself, and nothing from the page reaches app state.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, Platform } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { colors, space, mono } from '../theme/tokens.ts';

export interface MermaidViewProps {
  source: string;
  height?: number;
  onError?: (message: string) => void;
}

/**
 * Where to load mermaid from.
 *
 * A pinned CDN version is the default. Pinning matters: mermaid changes its
 * output between releases, and an unpinned major version can silently alter
 * every diagram in the app. An offline bundle can be supplied later by pointing
 * this at a local asset.
 */
export const MERMAID_VERSION = '11.4.1';
export const MERMAID_SRC = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;

const BRIDGE = 'window.__markReport = function (h, err) { window.ReactNativeWebView.postMessage(JSON.stringify({ h: h, err: err || null })); };';

/**
 * Build the page.
 *
 * Everything is inlined into a single HTML string so the WebView never needs to
 * navigate anywhere, and the mermaid source is the only external dependency.
 */
function buildHtml(source: string): string {
  // JSON.stringify escapes the diagram text, so a note containing `</script>`
  // or a quote cannot break out of the script block and inject markup.
  const encoded = JSON.stringify(source);
  const dark = Platform.OS === 'ios' ? '' : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<script src="${MERMAID_SRC}"></script>
<style>
  html, body { margin: 0; padding: 8px; background: transparent; }
  body { font-family: -apple-system, Roboto, "Helvetica Neue", sans-serif; }
  svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  .err { color: ${colors.danger}; font: 12px/1.4 monospace; white-space: pre-wrap; }
  ${dark}
</style>
</head>
<body>
<div id="out"></div>
<script>
  ${BRIDGE}
  (function () {
    var src = ${encoded};
    try {
      if (typeof mermaid === 'undefined') {
        document.getElementById('out').innerHTML = '<div class="err">mermaid.js failed to load (offline?)</div>';
        window.__markReport(60, 'mermaid.js 未能载入');
        return;
      }
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
        fontFamily: '-apple-system, Roboto, sans-serif'
      });
      var id = 'm' + Math.random().toString(36).slice(2);
      // A unique id per render: mermaid throws on a duplicate element id.
      mermaid.render(id, src).then(function (r) {
        document.getElementById('out').innerHTML = r.svg;
        var h = document.body.scrollHeight;
        window.__markReport(h, null);
      }).catch(function (e) {
        document.getElementById('out').innerHTML = '<div class="err">' + escapeHtml(String(e && e.message || e)) + '</div>';
        window.__markReport(60, String(e && e.message || e));
      });
    } catch (e) {
      window.__markReport(60, String(e));
    }
    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  })();
</script>
</body>
</html>`;
}

const style = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  loading: { height: 120, alignItems: 'center', justifyContent: 'center' },
  error: {
    padding: space.md,
    fontFamily: mono,
    fontSize: 12,
    color: colors.danger,
  },
});

export function MermaidView({ source, height = 200, onError }: MermaidViewProps): React.JSX.Element {
  const html = useMemo(() => buildHtml(source), [source]);
  const [measured, setMeasured] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const data = JSON.parse(event.nativeEvent.data) as { h?: number; err?: string | null };
        if (data.err) {
          setError(data.err);
          onError?.(data.err);
        } else if (typeof data.h === 'number' && data.h > 0) {
          setMeasured(data.h);
        }
      } catch {
        // A malformed bridge message is not worth surfacing; the diagram simply
        // stays at its default height.
      }
    },
    [onError],
  );

  if (error) {
    return (
      <View style={style.wrap}>
        <Text style={style.error} selectable>
          mermaid: {error}
        </Text>
      </View>
    );
  }

  return (
    <View style={[style.wrap, { height: measured ?? height }]}>
      {measured === null && !loadedRef.current ? (
        <View style={style.loading}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}
      <WebView
        // `source` html carries no navigation, so the WebView stays sealed.
        originWhitelist={['about:blank']}
        source={{ html, baseUrl: 'about:blank' }}
        onMessage={onMessage}
        onLoadEnd={() => {
          loadedRef.current = true;
        }}
        style={{ backgroundColor: 'transparent', flex: 1 }}
        // The page is our own HTML, so scripting must stay on; everything else
        // is unnecessary surface.
        javaScriptEnabled
        domStorageEnabled={false}
        allowsInlineMediaPlayback={false}
        setSupportMultipleWindows={false}
        androidLayerType="hardware"
      />
    </View>
  );
}