/**
 * Meridian Browse - Shared Protocol
 *
 * Message types for communication between MCP Server and Chrome Extension
 */

// Base message structure
export interface MeridianMessage {
  id: string;
  type: string;
  payload?: unknown;
}

// Request from server to extension
export interface MeridianRequest extends MeridianMessage {
  type: 'ping' | 'tabs_list' | 'navigate' | 'page_read' | 'click' | 'type' | 'screenshot';
}

// Response from extension to server
export interface MeridianResponse extends MeridianMessage {
  success: boolean;
  data?: unknown;
  error?: string;
}

// Specific message types

export interface PingRequest extends MeridianRequest {
  type: 'ping';
}

export interface PingResponse extends MeridianResponse {
  data: {
    pong: true;
    extensionVersion: string;
    timestamp: number;
  };
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  groupId?: number;
}

export interface TabsListRequest extends MeridianRequest {
  type: 'tabs_list';
}

export interface TabsListResponse extends MeridianResponse {
  data: {
    tabs: TabInfo[];
  };
}

// Connection status
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

// Helper to generate message IDs
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Default config
export const DEFAULT_CONFIG = {
  wsPort: 9333,
  wsHost: 'localhost',
  reconnectBaseDelay: 1000,
  reconnectMaxDelay: 30000,
  requestTimeout: 30000,
} as const;
