/**
 * Pages Function: POST /api/favorites
 * Same handler as the trigger Worker’s /favorites route.
 * Binding name on the Pages project must be EMAIL.
 */
import { handleFavoritesRequest } from '../../worker/favorites-mail.js';

export function onRequest(context) {
  return handleFavoritesRequest(context.request, context.env || {});
}
