import type { MentalLegosDesktopApi } from '../shared/contracts';

declare global {
  interface Window {
    mentalLegos: MentalLegosDesktopApi;
  }
}

export {};
