// Backend API base URL. VITE_API_URL must be set for any deployed build
// (e.g. https://wizard-backend.vercel.app); local dev falls back to the
// standard localhost backend.
export const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'
