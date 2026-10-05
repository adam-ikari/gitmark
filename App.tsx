import React from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';

import { RenderScreen } from './app/screens/RenderScreen.tsx';
import { colors } from './app/theme/tokens.ts';

export default function App(): React.JSX.Element {
  return (
    <SafeAreaView style={style.root}>
      <RenderScreen />
    </SafeAreaView>
  );
}

const style = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});