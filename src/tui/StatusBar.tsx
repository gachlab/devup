import React from 'react';
import { Box, Text } from 'ink';

export function StatusBar() {
  return (
    <Box>
      <Text>
        <Text bold>q</Text> Quit  <Text bold>Tab</Text> Switch  <Text bold>↑↓</Text> Scroll  <Text bold>PgUp/PgDn</Text> Page  <Text bold>Ctrl+A/E</Text> Home/End  <Text bold>c</Text> Clear  <Text bold>f</Text> Filter  <Text bold>L</Text> Level  <Text bold>a</Text> All  <Text bold>r</Text> Restart  <Text bold>/</Text> Search  <Text bold>s</Text> Sort  <Text bold>o</Text> Open  <Text bold>p</Text> Pause  <Text bold>t</Text> Time  <Text bold>T</Text> Proxy
      </Text>
    </Box>
  );
}
