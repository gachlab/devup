import React, { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import type { LogEntry } from './hooks/useProcessManager.js';
import { tagColors, compileSearchPattern } from '../utils.js';

interface Props {
  logs: LogEntry[];
  filter: string | null;
  searchTerm: string | null;
  paused: boolean;
  showTimestamps: boolean;
  maxNameLen: number;
  height: number;
  focused: boolean;
  scrollOffset: number;
  resetScroll: () => void;
  levelFilter?: 'all' | 'error' | 'warn';
}

export function LogsPanel({ logs, filter, searchTerm, paused, showTimestamps, maxNameLen, height, focused, scrollOffset, resetScroll, levelFilter = 'all' }: Props) {
  const byService = filter ? logs.filter(l => l.svcName === filter) : logs;
  const filtered = levelFilter === 'all'
    ? byService
    : levelFilter === 'error'
      ? byService.filter(l => l.level === 'error')
      : byService.filter(l => l.level === 'error' || l.level === 'warn');
  const contentHeight = Math.max(1, height - 2);
  const totalLines = filtered.length;

  // scrollOffset = "líneas por encima del fondo": 0 = follow latest, N = N líneas atrás.
  const maxOffset = Math.max(0, totalLines - contentHeight);
  const effectiveOffset = scrollOffset === Number.MAX_SAFE_INTEGER
    ? maxOffset
    : Math.min(scrollOffset, maxOffset);
  const startIndex = Math.max(0, totalLines - contentHeight - effectiveOffset);
  const endIndex = Math.min(startIndex + contentHeight, totalLines);
  const visible = filtered.slice(startIndex, endIndex);

  // Reset scroll cuando cambia el filtro o búsqueda — vuelve a seguir lo último.
  useEffect(() => {
    resetScroll();
  }, [filter, searchTerm, resetScroll]);

  const matcher = useMemo(() => compileSearchPattern(searchTerm), [searchTerm]);

  const scrolled = effectiveOffset > 0;
  const label = [
    'Logs',
    filter ? `[${filter}]` : '',
    searchTerm ? `/${searchTerm}` : '',
    matcher?.invalid ? '(invalid regex)' : '',
    levelFilter !== 'all' ? `[level: ${levelFilter}${levelFilter === 'warn' ? '+error' : ''}]` : '',
    paused ? '[PAUSED]' : '',
    scrolled ? '[SCROLL]' : '',
    `${filtered.length} lines`,
    focused && totalLines > 0 ? `(${startIndex + 1}-${endIndex}/${totalLines})` : '',
  ].filter(Boolean).join(' ');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} height={height}>
      <Box><Text bold color="cyan"> {label} </Text></Box>
      {visible.map((entry, i) => {
        const color = tagColors[entry.colorIdx % tagColors.length]!;
        const ts = showTimestamps ? new Date(entry.ts).toLocaleTimeString('en-GB') + ' ' : '';
        const line = entry.text;
        const isMatch = matcher ? matcher.test(line) : false;
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
