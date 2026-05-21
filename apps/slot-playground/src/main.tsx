import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// React 18 createRoot — explicit React 18 pin (not 19) because
// @react-three/fiber 8.x peer-deps on React 18 and StackBlitz's
// strict npm resolution refuses the install otherwise.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
