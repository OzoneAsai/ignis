export type PairingCard = {
  version: 1;
  deviceId: string;
  name: string;
  address: string;
  folderId: string;
  createdAt: number;
  expiresAt: number;
};

export type PairingCardInput = {
  deviceId: string;
  name: string;
  address: string;
  folderId?: string;
  now?: number;
};

export function encodePairingCard(input: PairingCardInput): string;
export function decodePairingCard(
  value: string, options?: { now?: number },
): PairingCard;
export function tailscaleIPv4Candidates(
  interfaces: Record<string, Array<{
    internal?: boolean;
    family?: string | number;
    address?: string;
  }> | undefined>,
): string[];
export function configuredTcpPorts(config: unknown): number[];
