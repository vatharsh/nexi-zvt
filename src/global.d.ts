import type { ZvtApi } from '../shared/types';

declare global {
  interface Window {
    zvt: ZvtApi;
  }
}

export {};
