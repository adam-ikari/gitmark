/**
 * Connecting a repository.
 *
 * Four fields and a token, because those are exactly what a sync needs and
 * nothing else. Validation happens on the field rather than after a failed
 * fetch, because the failure isomorphic-git reports for a bad URL
 * (`UnknownTransportError`, from inside a fetch) tells a user nothing about
 * which of their four inputs was wrong.
 *
 * The token input is deliberately `secureTextEntry`. It is stored in the OS
 * keystore and nowhere else — see app/git/credentials.ts — but that should not
 * stop it being shoulder-surfable on the way in.
 */

import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';

import {
  validateRemote,
  validateAuthor,
  loadSettings,
  saveSettings,
  saveToken,
  type RepoSettings,
} from '../git/credentials.ts';
import { colors, space, body, mono } from '../theme/tokens.ts';

export interface RepoSetupScreenProps {
  /** Called once the settings and token are stored. */
  onConnected: () => void;
  /** Text to show when a connection attempt fails. */
  error?: string | null;
}

export function RepoSetupScreen({ onConnected, error }: RepoSetupScreenProps): React.JSX.Element {
  const [settings, setSettings] = useState<RepoSettings | null>(null);
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Settings are read on mount, so a user who rotates their author name does
  // not have to retype the remote.
  React.useEffect(() => {
    let live = true;
    void loadSettings().then((s) => {
      if (live) setSettings(s);
    });
    return () => {
      live = false;
    };
  }, []);

  const update = useCallback((patch: Partial<RepoSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
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
    if (token.trim() === '') {
      setProblem('請填寫 Personal Access Token');
      return;
    }

    setProblem(null);
    setBusy(true);
    try {
      await saveSettings({ ...settings, remote: settings.remote.trim() });
      await saveToken(token);
      onConnected();
    } catch (err) {
      // A keystore write can fail (no secure enclave, device policy). Saying so
      // beats leaving the user on a form that appears to have worked.
      setProblem(err instanceof Error ? `無法儲存憑證：${err.message}` : '無法儲存憑證');
    } finally {
      setBusy(false);
    }
  }, [settings, token, onConnected]);

  if (!settings) {
    return (
      <View style={styles.root}>
        <Text style={styles.loading}>讀取設定…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>連結 Git 倉庫</Text>
      <Text style={styles.blurb}>
        筆記以純 markdown 存放於你的 GitHub 倉庫，在裝置上編輯、跨裝置同步。
      </Text>

      <Field label="遠端網址" hint="https://github.com/<owner>/<repo>.git">
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

      <Field label="分支" hint="預設 main">
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

      <Field label="作者名稱">
        <TextInput
          style={styles.input}
          value={settings.authorName}
          onChangeText={(authorName) => update({ authorName })}
          placeholder="你的名字"
          placeholderTextColor={colors.textMuted}
        />
      </Field>

      <Field label="作者 email">
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

      <Field
        label="Personal Access Token"
        hint="只存在系統金鑰，不寫入倉庫或日誌。需對此倉庫的寫入權限。"
      >
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="ghp_…"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </Field>

      {(problem ?? error) && <Text style={styles.problem}>{problem ?? error}</Text>}

      <Pressable
        onPress={() => void save()}
        disabled={busy}
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonDim]}
        accessibilityRole="button"
        accessibilityLabel="儲存並連結"
      >
        <Text style={styles.buttonText}>{busy ? '儲存中…' : '儲存並連結'}</Text>
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
  title: { ...body, fontSize: 22, fontWeight: '700', marginBottom: space.xs },
  blurb: { ...body, color: colors.textMuted, fontSize: 14, marginBottom: space.xl },
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
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  buttonDim: { opacity: 0.6 },
  buttonText: { ...body, color: '#ffffff', fontWeight: '700' },
});