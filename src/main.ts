import './style.css';
import { mountApp } from './ui/app';

mountApp(document.getElementById('app')!).catch(err => {
  console.error(err);
  document.getElementById('app')!.textContent = 'No se pudo iniciar PlanoLibre: ' + (err?.message || err);
});
