import { createContext } from 'react';

export type ToastTone = 'info' | 'success' | 'danger';

export type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
};

export type ToastApi = {
  show: (message: string, tone?: ToastTone) => void;
};

export const ToastContext = createContext<ToastApi | null>(null);
