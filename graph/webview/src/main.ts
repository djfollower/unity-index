import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('unity-index-graph: #app container missing in index.html');

mount(App, { target });
