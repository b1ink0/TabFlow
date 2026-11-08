// Same application, commands, durable conversations and maintenance runner alongside the current page.
import { mountWorkspace } from '../dashboard/mount';
if (!location.hash) location.hash = 'tabs';
mountWorkspace('sidepanel');
