export interface ShareRequest {
  action: string;
  target?: string;
  port?: string;
  mode?: string;
  path?: string;
  service?: string;
  files?: string[];
  folder?: string;
  domain?: string;
}
