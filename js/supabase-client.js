/**
 * Supabase client wrapper.
 *
 * Replace the placeholder values below with your own Supabase project URL
 * and anon (public) key. You can find these in your Supabase dashboard
 * under Settings → API.
 */

const SUPABASE_URL  = 'https://fleionvdiskrwapgtvkz.supabase.co';
const SUPABASE_ANON = 'sb_publishable_XsaDr96GwZfb9PMdxkfqKg_PIQTVMEa';

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

/* ---------- Books table helpers ---------- */

const db = {
  /**
   * Fetch all books, newest first.
   */
  async getAll() {
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .order('added_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  /**
   * Search books by title, author, or ISBN (case-insensitive).
   * Optionally filter by owner.
   */
  async search(query, owner) {
    let q = supabase
      .from('books')
      .select('*')
      .order('added_at', { ascending: false });

    if (query) {
      q = q.or(`title.ilike.%${query}%,author.ilike.%${query}%,isbn.ilike.%${query}%`);
    }
    if (owner) {
      q = q.eq('owner', owner);
    }

    const { data, error } = await q;
    if (error) throw error;
    return data;
  },

  /**
   * Check if a book with this ISBN already exists.
   */
  async findByIsbn(isbn) {
    const { data, error } = await supabase
      .from('books')
      .select('*')
      .eq('isbn', isbn)
      .maybeSingle();
    if (error) throw error;
    return data; // null if not found
  },

  /**
   * Insert a new book.
   */
  async insert(book) {
    const { data, error } = await supabase
      .from('books')
      .insert([book])
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Delete a book by ID.
   */
  async remove(id) {
    const { error } = await supabase
      .from('books')
      .delete()
      .eq('id', id);
    if (error) throw error;
  }
};
