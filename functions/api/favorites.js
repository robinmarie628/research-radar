/**
 * Unused by the page. 收藏 downloads Markdown in the browser.
 * Email Routing cannot send until this account has a custom domain,
 * so the client no longer POSTs /api/favorites or Worker /favorites.
 * Kept so a domain can turn sending back on. Do not add an EMAIL binding yet.
 *
 * Pages Function: POST /api/favorites
 * Same handler as the trigger Worker’s /favorites route.
 * Binding name on the Pages project must be EMAIL.
 */
import { handleFavoritesRequest } from '../../worker/favorites-mail.js';

export function onRequest(context) {
  return handleFavoritesRequest(context.request, context.env || {});
}
