/**
 * Sign-in: GitHub account, or the repository details.
 *
 * There is no token field any more. A personal access token meant the user had to
 * know what a fine-grained token is, which permission to tick, and that the value
 * they paste is a bearer credential for their whole account. Signing in with
 * GitHub removes that knowledge: the App's permissions were fixed when it was
 * created, the user approves it, and the token never passes through their hands.
 *
 * The screen also earns its keep by naming the most likely failure. A GitHub App
 * that is not installed on the notes repository produces a push that fails with
 * an opaque 401; here that is a sentence next to the field.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';

import {
  loadSettings,
  saveSettings,
  validateRemote,
  validateAuthor,
  repoFromRemote,
  type RepoSettings,
} from '../git/credentials.ts';
import { describeSession, isSignedIn, type AuthSession } from '../../core/github/auth.ts';
import { consentUrl, completeSignIn, signOut, sessionForSync, SignInError, REDIRECT_URI } from '../github/signIn.ts';
import { getStoredSession } from '../github/store.ts';
import { colors, space, body, mono } from '../theme/tokens.ts';

export interface RepoSetupScreenProps {
  /** Called once the settings are stored and a session exists. */
  onConnected: () => void;
  /** Text to show when a connection attempt fails. */
  error?: string | null;
}

export function RepoSetupScreen({ onConnected, error }: RepoSetupScreenProps): React.JSX.Element {
  const [settings, setSettings] = useState<RepoSettings | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [s, stored] = await Promise.all([loadSettings(), getStoredSession()]);
      if (!live) return;
      setSettings(s);
      setSession(stored);
    })();
    return () => {
      live = false;
    };
  }, []);

  const update = useCallback((patch: Partial<RepoSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const signedIn = session !== null && isSignedIn(session);
  const target = settings ? repoFromRemote(settings.remote) : null;
  const installed = session?.installations ?? [];

  /** Start the browser flow and wait for GitHub to redirect back. */
  const signIn = useCallback(async () => {
    setProblem(null);
    setBusy(true);
    try {
      // `openAuthSessionAsync`, not `openBrowserAsync`: this one waits for the
      // redirect to our custom scheme and hands back the URL, which is the whole
      // point of the flow. The plain browser call returns only "opened".
      const { openAuthSessionAsync } = await import('expo-web-browser');
      const result = await openAuthSessionAsync(await consentUrl(), REDIRECT_URI);

      if (result.type !== 'success') {
        // Backing out of the browser is what cancelling looks like, not an error
        // to report — the user did the expected thing.
        setProblem(null);
        return;
      }
      setSession(await completeSignIn(result.url));
    } catch (err) {
      setProblem(err instanceof SignInError ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;

    const remoteProblem = validateRemote(settings.remote);
    if (remoteProblem) {
      setProblem(remoteProblem);
      return;
    }
    const authorProblem = validateAuthor(settings.authorName, settings.authorEmail);
    if (authorProblem) {
      setProblem(authorProblem);
      return;
    }
    if (!signedIn) {
      setProblem('请先用 GitHub 帐号登录');
      return;
    }

    setProblem(null);
    setBusy(true);
    try {
      // Renewing here means a freshly configured repo also gets a live token, so
      // the first sync does not immediately have to refresh.
      const live = await sessionForSync();
      await saveSettings({ ...settings, remote: settings.remote.trim() });
      setSession(live);
      onConnected();
    } catch (err) {
      setProblem(err instanceof SignInError ? err.message : '无法保存设置');
    } finally {
      setBusy(false);
    }
  }, [settings, signedIn, onConnected]);

  const disconnect = useCallback(() => {
    setBusy(true);
    void signOut().then(() => {
      setSession(null);
      setBusy(false);
    });
  }, []);

  if (!settings) {
    return (
      <View style={styles.root}>
        <Text style={styles.loading}>读取设置…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>连接 Git 仓库</Text>

      <View style={styles.account}>
        {signedIn ? (
          <>
            <Text style={styles.accountWho}>{describeSession(session, Date.now())}</Text>
            {installed.length > 0 && (
              <Text style={styles.accountHint}>
                App 已安装在：{installed.join('、')}
              </Text>
            )}
            {target !== null && !installed.includes(target.split('/')[0]!) && (
              <Text style={styles.warn}>
                这个 App 还没有安装在 {target} 所在的帐号上。即使授权成功，推送也会被拒绝。
              </Text>
            )}
            <Pressable
              onPress={disconnect}
              disabled={busy}
              style={({ pressed }) => [styles.link, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="退出登录"
            >
              <Text style={styles.linkText}>退出登录</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.accountHint}>
              用 GitHub 帐号登录。App 只请求所安装仓库的读写权限，令牌只存在系统金钥里，
              不写入仓库、不写入日志。
            </Text>
            <Pressable
              onPress={() => void signIn()}
              disabled={busy}
              style={({ pressed }) => [styles.signIn, (pressed || busy) && styles.dim]}
              accessibilityRole="button"
              accessibilityLabel="使用 GitHub 帐号登录"
            >
              <Text style={styles.signInText}>{busy ? '正在打开浏览器…' : '使用 GitHub 帐号登录'}</Text>
            </Pressable>
            <Text style={styles.fineprint}>
              首次登录需要在 GitHub 上把 mark 安装到你的笔记仓库；只对已安装的仓库生效。
              访问令牌 8 小时过期，App 会在过期前自动续期，不需要你再操作。
            </Text>
          </>
        )}
      </View>

      <Field label="远端网址" hint="https://github.com/<owner>/<repo>.git">
        <TextInput
          style={styles.input}
          value={settings.remote}
          onChangeText={(remote) => update({ remote })}
          placeholder="https://github.com/owner/repo.git"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>

      <Field label="分支" hint="默认 main">
        <TextInput
          style={styles.input}
          value={settings.branch}
          onChangeText={(branch) => update({ branch })}
          placeholder="main"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label="作者名称">
        <TextInput
          style={styles.input}
          value={settings.authorName}
          onChangeText={(authorName) => update({ authorName })}
          placeholder="你的名字"
          placeholderTextColor={colors.textMuted}
        />
      </Field>

      <Field label="作者邮箱">
        <TextInput
          style={styles.input}
          value={settings.authorEmail}
          onChangeText={(authorEmail) => update({ authorEmail })}
          placeholder="you@example.com"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
      </Field>

      {(problem ?? error) && <Text style={styles.problem}>{problem ?? error}</Text>}

      <Pressable
        onPress={() => void save()}
        disabled={busy || !signedIn}
        style={({ pressed }) => [styles.button, (pressed || busy || !signedIn) && styles.dim]}
        accessibilityRole="button"
        accessibilityLabel="保存并连接"
      >
        <Text style={styles.buttonText}>保存并连接</Text>
      </Pressable>
    </ScrollView>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.lg, paddingBottom: space.xxl },
  loading: { ...body, color: colors.textMuted, padding: space.lg },
  title: { ...body, fontSize: 22, fontWeight: '700', marginBottom: space.lg },
  account: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: space.md,
    marginBottom: space.xl,
    backgroundColor: colors.surface,
    gap: space.xs,
  },
  accountWho: { ...body, fontWeight: '700' },
  accountHint: { ...body, fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  fineprint: { ...body, fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  warn: { ...body, fontSize: 13, color: colors.danger, lineHeight: 19 },
  signIn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: space.md,
    alignItems: 'center',
    marginTop: space.xs,
  },
  signInText: { ...body, color: '#ffffff', fontWeight: '700' },
  link: { paddingVertical: space.xs, alignSelf: 'flex-start' },
  linkText: { ...body, fontSize: 13, color: colors.accent },
  field: { marginBottom: space.lg },
  label: { ...body, fontSize: 13, fontWeight: '700', marginBottom: space.xs },
  input: {
    ...body,
    fontFamily: mono,
    fontSize: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.surface,
  },
  hint: { ...body, fontSize: 12, color: colors.textMuted, marginTop: space.xs },
  problem: { ...body, color: colors.danger, fontSize: 14, marginBottom: space.md },
  button: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: space.md, alignItems: 'center' },
  buttonText: { ...body, color: '#ffffff', fontWeight: '700' },
  dim: { opacity: 0.6 },
  pressed: { opacity: 0.7 },
});
