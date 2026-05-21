import { useState, useEffect } from 'react';
import axios from 'axios';
import { supabase } from '../lib/auth';
import { useT } from '../context/LanguageContext';

interface InvestModalProps {
  projectId: string;
  projectTitle: string;
  onClose: () => void;
}

type Step = 'amount' | 'quote' | 'success';

interface Quote {
  mxn: number;
  eth: number;
  rate: number;
  simulation: boolean;
}

interface BuyResult {
  orderId: string;
  txHash: string;
  mxn: number;
  eth: number;
  rate: number;
  simulation: boolean;
  message: string;
}

export default function InvestModal({ projectId, projectTitle, onClose }: InvestModalProps) {
  const [step, setStep] = useState<Step>('amount');
  const [mxn, setMxn] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [result, setResult] = useState<BuyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const t = useT();

  const getAuthHeader = async (): Promise<string> => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return token ? `Bearer ${token}` : 'Bearer sim-token';
  };

  // Fetch balance on mount
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const token = data.session?.access_token;
      if (!token) return;
      try {
        const res = await axios.get('/api/balance/me', { headers: { Authorization: `Bearer ${token}` } });
        setBalance(res.data.mxn);
      } catch { /* ignore */ }
    });
  }, []);

  const handleGetQuote = async () => {
    const amount = parseFloat(mxn);
    if (!amount || amount < 100) {
      setError(t('invest.amount_error'));
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { data } = await axios.get(`/api/invest/quote?mxn=${amount}`);
      setQuote(data);
      setStep('quote');
    } catch (err: any) {
      setError(err.response?.data?.error || t('invest.error_quote'));
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!quote) return;
    setError('');
    setLoading(true);
    try {
      const authHeader = await getAuthHeader();
      const { data } = await axios.post(
        '/api/invest/buy',
        { projectId, mxn: quote.mxn },
        { headers: { Authorization: authHeader } }
      );
      setResult(data);
      if (data.remainingBalance !== undefined) setBalance(data.remainingBalance);
      setStep('success');
    } catch (err: any) {
      setError(err.response?.data?.error || t('invest.error_confirm'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="w-full max-w-sm rounded-2xl p-6 relative" style={{ background: '#0d1520', border: '1px solid #1e2d3d' }}>
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 text-xl leading-none">×</button>

        <h2 className="text-lg font-bold mb-1" style={{ color: '#e8f4f0' }}>{t('invest.title')}</h2>
        <p className="text-sm mb-5 truncate" style={{ color: '#6b7280' }}>{projectTitle}</p>

        {step === 'amount' && (
          <div className="space-y-4">
            {balance !== null && (
              <div className="flex items-center justify-between text-xs px-3 py-2 rounded-lg" style={{ background: '#080c10', border: '1px solid #1e2d3d' }}>
                <span style={{ color: '#6b7280' }}>{t('invest.balance_label')}</span>
                <span className="font-semibold" style={{ color: '#00e5c4' }}>
                  ${balance.toLocaleString('es-MX')} MXN
                </span>
              </div>
            )}
            <div>
              <label className="block text-xs mb-1.5" style={{ color: '#9ca3af' }}>{t('invest.amount_label')}</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: '#6b7280' }}>$</span>
                <input
                  type="number" min="100" step="50" value={mxn}
                  onChange={(e) => setMxn(e.target.value)}
                  placeholder="500"
                  className="w-full pl-7 pr-3 py-2.5 rounded-lg text-sm outline-none"
                  style={{ background: '#080c10', border: '1px solid #1e2d3d', color: '#e8f4f0' }}
                  onKeyDown={(e) => e.key === 'Enter' && handleGetQuote()}
                />
              </div>
              <p className="text-xs mt-1" style={{ color: '#6b7280' }}>{t('invest.amount_min')}</p>
            </div>
            {error && <p className="text-xs py-2 px-3 rounded-lg" style={{ background: '#2d0a0a', color: '#f87171' }}>{error}</p>}
            <button onClick={handleGetQuote} disabled={loading} className="w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50" style={{ background: '#00e5c4', color: '#080c10' }}>
              {loading ? t('invest.loading') : t('invest.quote_btn')}
            </button>
          </div>
        )}

        {step === 'quote' && quote && (
          <div className="space-y-4">
            <div className="space-y-2 py-3 px-4 rounded-xl" style={{ background: '#080c10' }}>
              <div className="flex justify-between text-sm">
                <span style={{ color: '#9ca3af' }}>{t('invest.you_invest')}</span>
                <span style={{ color: '#e8f4f0', fontWeight: 600 }}>${quote.mxn.toLocaleString('es-MX')} MXN</span>
              </div>
              <div className="flex justify-between text-sm">
                <span style={{ color: '#9ca3af' }}>{t('invest.you_receive')}</span>
                <span style={{ color: '#00e5c4', fontWeight: 600 }}>{quote.eth.toFixed(6)} ETH</span>
              </div>
              <div className="h-px" style={{ background: '#1e2d3d' }} />
              <div className="flex justify-between text-xs">
                <span style={{ color: '#6b7280' }}>{t('invest.rate')}</span>
                <span style={{ color: '#6b7280' }}>${quote.rate.toLocaleString('es-MX')} MXN/ETH</span>
              </div>
            </div>
            {error && <p className="text-xs py-2 px-3 rounded-lg" style={{ background: '#2d0a0a', color: '#f87171' }}>{error}</p>}
            <div className="flex gap-3">
              <button onClick={() => { setStep('amount'); setError(''); }} className="flex-1 py-2.5 rounded-lg text-sm font-medium transition-opacity hover:opacity-80" style={{ background: '#1e2d3d', color: '#9ca3af' }}>
                {t('invest.change')}
              </button>
              <button onClick={handleConfirm} disabled={loading} className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50" style={{ background: '#00e5c4', color: '#080c10' }}>
                {loading ? t('invest.confirming') : t('invest.confirm')}
              </button>
            </div>
          </div>
        )}

        {step === 'success' && result && (
          <div className="space-y-4 text-center">
            <div className="text-4xl">✅</div>
            <div>
              <p className="font-semibold mb-1" style={{ color: '#e8f4f0' }}>{result.message}</p>
              <p className="text-sm" style={{ color: '#6b7280' }}>${result.mxn.toLocaleString('es-MX')} MXN → {result.eth.toFixed(6)} ETH</p>
            </div>
            {balance !== null && (
              <div className="flex items-center justify-between text-xs px-3 py-2 rounded-lg" style={{ background: '#080c10', border: '1px solid #1e2d3d' }}>
                <span style={{ color: '#6b7280' }}>{t('invest.balance_remaining')}</span>
                <span className="font-semibold" style={{ color: '#00e5c4' }}>${balance.toLocaleString('es-MX')} MXN</span>
              </div>
            )}
            <div className="text-left text-xs space-y-1 py-3 px-4 rounded-xl" style={{ background: '#080c10' }}>
              <div className="flex gap-2">
                <span style={{ color: '#6b7280' }}>Order ID:</span>
                <span className="font-mono truncate" style={{ color: '#9ca3af' }}>{result.orderId}</span>
              </div>
              <div className="flex gap-2">
                <span style={{ color: '#6b7280' }}>Tx Hash:</span>
                <span className="font-mono truncate" style={{ color: '#9ca3af' }}>{result.txHash.slice(0, 20)}…</span>
              </div>
            </div>
            <button onClick={onClose} className="w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90" style={{ background: '#00e5c4', color: '#080c10' }}>
              {t('invest.close')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
