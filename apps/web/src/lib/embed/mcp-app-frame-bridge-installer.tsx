'use client';

import { useEffect } from 'react';
import { installMcpAppFrameBridge } from './mcp-app-frame-bridge';

/**
 * Mounts the Claude MCP App frame bridge once. Renders no DOM. Outside the
 * MCP App frame (`embed=mcp-app` + framed) the install call returns at once
 * and attaches nothing. The bridge stays installed for the life of the tab
 * (no cleanup), so client-side navigation away from the world routes keeps it.
 */
export function McpAppFrameBridgeInstaller(): null {
  useEffect(() => {
    installMcpAppFrameBridge();
  }, []);
  return null;
}
