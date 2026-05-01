import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  onSubmit: (term: string | null) => void;
  onClose: () => void;
}

export function SearchInput({ onSubmit, onClose }: Props) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.escape) onClose();
    else if (key.return) onSubmit(value.trim() || null);
    else if (key.backspace || key.delete) setValue(v => v.slice(0, -1));
    else if (input && !key.ctrl && !key.meta) setValue(v => v + input);
  }, { isActive: process.stdin.isTTY ?? false });

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">Search: </Text>
      <Text>{value}</Text>
      <Text dimColor>█</Text>
    </Box>
  );
}
