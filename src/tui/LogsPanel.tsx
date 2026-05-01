import React from 'react';
import { Box, Text } from 'ink';
import type { LogEntry } from './hooks/useProcessManager.js';
import { tagColors } from '../utils.js';

interface Props {
  logs: LogEntry[];
  filter: string | null;
  searchTerm: string | null;
  paused: boolean;
  showTimestamps: boolean;
  maxNameLen: number;
  height: number;
  focused: boolean;
}

export function LogsPanel({ logs, filter, searchTerm, paused, showTimestamps, maxNameLen, height, focused }: Props) {
  const filtered = filter ? logs.filter(l => l.svcName === filter) : logs;
  const contentHeight = height - 2;
  const visible = filtered.slice(-contentHeight);

  const label = [
    'Logs',
    filter ? `[${filter}]` : '',
    searchTerm ? `/${searchTerm}` : '',
    paused ? '[PAUSED]' : '',
    `${filtered.length} lines`,
  ].filter(Boolean).join(' ');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} height={height}>
      <Box><Text bold color="cyan"> {label} </Text></Box>
      {visible.map((entry, i) => {
        const color = tagColors[entry.colorIdx % tagColors.length]!;
        const ts = showTimestamps ? new Date(entry.ts).toLocaleTimeString('en-GB') + ' ' : '';
        const line = entry.text;
        const isMatch = searchTerm && line.toLowerCase().includes(searchTerm.toLowerCase());
        return (
          <Box key={i}>
            {showTimestamps && <Text dimColor>{ts}</Text>}
            <Text color={color}>[{entry.svcName.padEnd(maxNameLen)}]</Text>
            <Text> </Text>
            {isMatch ? <Text backgroundColor="yellow" color="black">{line}</Text> : <Text>{line}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
