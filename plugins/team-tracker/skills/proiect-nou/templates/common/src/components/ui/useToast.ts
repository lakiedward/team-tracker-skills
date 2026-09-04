import { useContext } from 'react';
import { ToastContext, type ToastApi } from './toastContext';

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error('useToast se folosește doar sub <ToastProvider>');
  }
  return api;
}
