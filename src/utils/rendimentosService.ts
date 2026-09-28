import { getSupabaseClient } from './supabaseClient';

export interface RendimentoItem {
  id: string;
  produto: string;
  rendimento: string;
  unidade: string;
  observacao?: string;
  createdAt: string;
  updatedAt: string;
}

export const RENDIMENTOS_STORAGE_KEY = 'fenix_calculadora_rendimentos';

export const UNIDADES_PADRAO_RENDIMENTO = [
  'm²/caixa',
  'm²/balde',
  'm²/rolo',
  'm²/unidade',
  'm²/bisnaga',
  'm/barra',
  'm/rolo',
  'kg/m²',
  'unidade',
];

// Cache em memória para acesso síncrono rápido (não depende de LocalStorage)
let memoryCache: RendimentoItem[] = [];

/**
 * Helper interno para remover duplicidades preservando a integridade pelo ID
 */
function deduplicateList(list: RendimentoItem[]): RendimentoItem[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const result: RendimentoItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !item.id) continue;
    const cleanId = String(item.id).trim();
    if (!seen.has(cleanId)) {
      seen.add(cleanId);
      result.push({
        id: cleanId,
        produto: String(item.produto || '').trim(),
        rendimento: String(item.rendimento || '').trim(),
        unidade: String(item.unidade || '').trim(),
        observacao: item.observacao ? String(item.observacao).trim() : '',
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
      });
    }
  }
  return result;
}

/**
 * Retorna os rendimentos do cache em memória atual.
 */
export function getStoredRendimentos(): RendimentoItem[] {
  return [...memoryCache];
}

/**
 * Carrega a lista oficial de rendimentos diretamente do Supabase.
 * Se não houver itens cadastrados pelo usuário, retorna lista vazia.
 * Não cria dados fictícios ou automáticos.
 */
export async function loadRendimentosFromSupabase(): Promise<RendimentoItem[]> {
  const client = getSupabaseClient();
  if (!client) {
    return [...memoryCache];
  }

  try {
    const { data: row, error } = await client
      .from('fenix_kv_store')
      .select('data')
      .eq('key', RENDIMENTOS_STORAGE_KEY)
      .maybeSingle();

    if (error) {
      console.warn('Erro ao consultar rendimentos no Supabase:', error);
      return [...memoryCache];
    }

    if (row && row.data !== undefined) {
      let remoteList: any = row.data;
      if (typeof remoteList === 'string') {
        try {
          remoteList = JSON.parse(remoteList);
        } catch {
          remoteList = [];
        }
      }

      if (Array.isArray(remoteList)) {
        memoryCache = deduplicateList(remoteList);
        return [...memoryCache];
      }
    }

    // Se o registro não existe ou é vazio, a tabela é vazia
    memoryCache = [];
    return [];
  } catch (err) {
    console.warn('Falha na requisição de rendimentos ao Supabase:', err);
    return [...memoryCache];
  }
}

/**
 * Salva ou atualiza um cadastro de rendimento diretamente no Supabase.
 * - Produto, Rendimento, Unidade e Observação são persistidos na nuvem.
 * - Não cria duplicados.
 * - Não utiliza LocalStorage.
 */
export async function saveRendimento(
  itemData: {
    produto: string;
    rendimento: string;
    unidade: string;
    observacao?: string;
  },
  existingId?: string
): Promise<RendimentoItem> {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Falha ao conectar ao servidor do Supabase. Verifique a conexão.');
  }

  const now = new Date().toISOString();
  const user =
    (typeof localStorage !== 'undefined' && (localStorage.getItem('fenix_active_user_name') || localStorage.getItem('fenix_saved_username'))) ||
    'Usuário Fênix';

  // 1. Busca a lista mais recente do Supabase para evitar conflitos de concorrência
  let currentList: RendimentoItem[] = [];
  try {
    const { data: row, error: fetchErr } = await client
      .from('fenix_kv_store')
      .select('data')
      .eq('key', RENDIMENTOS_STORAGE_KEY)
      .maybeSingle();

    if (!fetchErr && row && row.data !== undefined) {
      let rData = row.data;
      if (typeof rData === 'string') {
        try {
          rData = JSON.parse(rData);
        } catch {}
      }
      if (Array.isArray(rData)) {
        currentList = deduplicateList(rData);
      }
    } else if (memoryCache.length > 0) {
      currentList = [...memoryCache];
    }
  } catch {
    currentList = [...memoryCache];
  }

  // 2. Prepara o item salvo
  let savedItem: RendimentoItem;
  if (existingId) {
    const existingIndex = currentList.findIndex((i) => i.id === existingId);
    savedItem = {
      id: existingId,
      produto: itemData.produto.trim(),
      rendimento: itemData.rendimento.trim(),
      unidade: itemData.unidade.trim(),
      observacao: itemData.observacao?.trim() || '',
      createdAt: existingIndex >= 0 ? currentList[existingIndex].createdAt : now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      currentList[existingIndex] = savedItem;
    } else {
      currentList = [savedItem, ...currentList];
    }
  } else {
    savedItem = {
      id: `rend_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      produto: itemData.produto.trim(),
      rendimento: itemData.rendimento.trim(),
      unidade: itemData.unidade.trim(),
      observacao: itemData.observacao?.trim() || '',
      createdAt: now,
      updatedAt: now,
    };
    currentList = [savedItem, ...currentList.filter((i) => i.id !== savedItem.id)];
  }

  // 3. Remove duplicidades
  const finalizedList = deduplicateList(currentList);

  // 4. Persiste diretamente no Supabase fenix_kv_store
  const { error: upsertErr } = await client
    .from('fenix_kv_store')
    .upsert(
      {
        key: RENDIMENTOS_STORAGE_KEY,
        data: finalizedList,
        updated_at: now,
        updated_by: user,
      },
      { onConflict: 'key' }
    );

  if (upsertErr) {
    console.error('Erro no Supabase ao salvar rendimento:', upsertErr);
    throw new Error(upsertErr.message || 'Erro ao persistir rendimento no Supabase.');
  }

  // 5. Atualiza o cache em memória imediatamente
  memoryCache = finalizedList;

  // 6. Notifica o sistema para atualização visual em tempo real
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('fenix_rendimentos_updated', { detail: { items: finalizedList } })
    );
  }

  return savedItem;
}

/**
 * Remove definitivamente um item de rendimento no Supabase.
 */
export async function deleteRendimento(id: string): Promise<boolean> {
  if (!id) return false;

  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Falha ao conectar ao servidor do Supabase.');
  }

  const now = new Date().toISOString();
  const user =
    (typeof localStorage !== 'undefined' && (localStorage.getItem('fenix_active_user_name') || localStorage.getItem('fenix_saved_username'))) ||
    'Usuário Fênix';

  // 1. Busca lista remota atual
  let currentList: RendimentoItem[] = [];
  try {
    const { data: row } = await client
      .from('fenix_kv_store')
      .select('data')
      .eq('key', RENDIMENTOS_STORAGE_KEY)
      .maybeSingle();

    if (row && row.data !== undefined) {
      let rData = row.data;
      if (typeof rData === 'string') {
        try {
          rData = JSON.parse(rData);
        } catch {}
      }
      if (Array.isArray(rData)) {
        currentList = deduplicateList(rData);
      }
    } else {
      currentList = [...memoryCache];
    }
  } catch {
    currentList = [...memoryCache];
  }

  // 2. Filtra o item a ser excluído
  const filtered = currentList.filter((item) => item.id !== id);

  // 3. Atualiza diretamente o Supabase
  const { error } = await client
    .from('fenix_kv_store')
    .upsert(
      {
        key: RENDIMENTOS_STORAGE_KEY,
        data: filtered,
        updated_at: now,
        updated_by: user,
      },
      { onConflict: 'key' }
    );

  if (error) {
    console.error('Erro ao excluir rendimento no Supabase:', error);
    throw new Error(error.message || 'Erro ao excluir rendimento no Supabase.');
  }

  // 4. Atualiza cache em memória e dispara evento
  memoryCache = filtered;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('fenix_rendimentos_updated', { detail: { items: filtered } })
    );
  }

  return true;
}

/**
 * Limpa todos os rendimentos no Supabase.
 */
export async function clearAllRendimentos(): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;

  const now = new Date().toISOString();
  const user =
    (typeof localStorage !== 'undefined' && (localStorage.getItem('fenix_active_user_name') || localStorage.getItem('fenix_saved_username'))) ||
    'Usuário Fênix';

  const { error } = await client
    .from('fenix_kv_store')
    .upsert(
      {
        key: RENDIMENTOS_STORAGE_KEY,
        data: [],
        updated_at: now,
        updated_by: user,
      },
      { onConflict: 'key' }
    );

  if (error) return false;

  memoryCache = [];
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('fenix_rendimentos_updated', { detail: { items: [] } })
    );
  }

  return true;
}
