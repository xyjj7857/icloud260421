/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  LayoutDashboard, 
  Settings, 
  History, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Download,
  Wallet,
  TrendingUp,
  FileText,
  AlertCircle,
  CheckCircle2,
  Power,
  PowerOff,
  Clock,
  ArrowRightLeft
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast, Toaster } from 'sonner';
import { format, subDays } from 'date-fns';
import * as XLSX from 'xlsx';

interface Account {
  id: string;
  name: string;
  isActive: boolean;
}

interface Balance {
  asset: string;
  balance: string;
  available: string;
  type: 'spot' | 'futures';
}

interface Position {
  accountId: string;
  accountName: string;
  symbol: string;
  amount: string;
  entryPrice: string;
  markPrice: string;
  pnl: string;
}

interface Order {
  orderId?: number | string;
  algoId?: number | string;
  accountId: string;
  accountName: string;
  symbol: string;
  side: string;
  type: string;
  price: string;
  stopPrice?: string;
  qty: string;
  status: string;
  time: number;
  isAlgo?: boolean;
}

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    return !!localStorage.getItem('gatekeeper_token');
  });
  const [loginPassword, setLoginPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [balances, setBalances] = useState<Record<string, Balance[]>>({});
  const [positions, setPositions] = useState<Record<string, Position[]>>({});
  const [orders, setOrders] = useState<Record<string, Order[]>>({});
  const [accountStatus, setAccountStatus] = useState<Record<string, string>>({});
  const [isAddingAccount, setIsAddingAccount] = useState(false);
  const [newAccount, setNewAccount] = useState({ name: '', apiKey: '', apiSecret: '' });
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [isQueryingHistory, setIsQueryingHistory] = useState(false);
  const [startDate, setStartDate] = useState(format(subDays(new Date(), 7), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [timeStatsMode, setTimeStatsMode] = useState<'02' | '58'>('02');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [systemStatus, setSystemStatus] = useState({ apiStatus: 'Checking...', wsStatus: 'Checking...', serverIp: '...' });
  const [systemLogs, setSystemLogs] = useState<any[]>([]);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log("[Socket] Connected, subscribing to all accounts...");
      // Trigger subscription after connection
      fetchAccounts(); 
    });

    fetchAccounts();
    fetchSystemStatus();
    fetchLogs();
    const statusInterval = setInterval(() => {
      fetchSystemStatus();
      fetchLogs();
    }, 10000); // 10s status check

    newSocket.on('binance_update', ({ accountId, accountName, data }: { accountId: string, accountName: string, data: any }) => {
      handleBinanceUpdate(accountId, accountName, data);
    });

    newSocket.on('binance_initial_data', ({ accountId, accountName, balances, positions, orders }: { accountId: string, accountName: string, balances: any[], positions: any[], orders: any[] }) => {
      console.log(`[Socket] Initial data for ${accountName}:`, { balances: balances?.length, positions: positions?.length, orders: orders?.length });
      setBalances(prev => ({ ...prev, [accountId]: balances }));
      setPositions(prev => ({ ...prev, [accountId]: (positions || []).map(p => ({ ...p, accountId, accountName })) }));
      if (orders) {
        setOrders(prev => ({ ...prev, [accountId]: (orders || []).map(o => ({ ...o, accountId, accountName })) }));
      }
      setLastUpdated(new Date());
    });

    newSocket.on('ws_status', ({ accountId, status }: { accountId: string, status: string }) => {
      setAccountStatus(prev => ({ ...prev, [accountId]: status }));
    });

    return () => {
      newSocket.close();
      clearInterval(statusInterval);
    };
  }, []);

  useEffect(() => {
    if (!socket || accounts.length === 0) return;

    // Ensure client is subscribed to all active account rooms
    console.log(`[Socket] Subscribing to rooms for ${accounts.length} accounts`);
    accounts.forEach(acc => {
      socket.emit('subscribe', acc.id.toString());
    });

    const refreshInterval = setInterval(() => {
      accounts.forEach(acc => {
        socket.emit('refresh_data', acc.id);
      });
    }, 600000); // 10 minute sync

    return () => clearInterval(refreshInterval);
  }, [socket, accounts]);

  const [isSyncing, setIsSyncing] = useState(false);
  const [isSyncDialogOpen, setIsSyncDialogOpen] = useState(false);
  const [syncStartDate, setSyncStartDate] = useState(format(subDays(new Date(), 3), 'yyyy-MM-dd'));
  const [syncEndDate, setSyncEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const [isTransferDialogOpen, setIsTransferDialogOpen] = useState(false);
  const [transferAmount, setTransferAmount] = useState('');
  const [transferAccountId, setTransferAccountId] = useState<string | null>(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferPassword, setTransferPassword] = useState('');

  const getAuthHeaders = () => {
    const token = localStorage.getItem('gatekeeper_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  };

  const fetchWithAuth = async (url: string, options: RequestInit = {}) => {
    const headers = {
      ...options.headers,
      ...getAuthHeaders()
    };
    return fetch(url, { ...options, headers, credentials: 'include' });
  };

  const triggerManualSync = async () => {
    if (!selectedAccountId) {
      toast.warning('请先在左侧列表中选择一个账户');
      return;
    }
    
    const start = new Date(syncStartDate + 'T00:00:00').getTime();
    const end = new Date(syncEndDate + 'T23:59:59').getTime();
    
    if (start > end) {
      toast.error('开始日期不能晚于结束日期');
      return;
    }

    setIsSyncing(true);
    setIsSyncDialogOpen(false);
    try {
      const res = await fetchWithAuth('/api/system/sync', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          accountId: selectedAccountId,
          startTime: start,
          endTime: end
        })
      });
      if (res.ok) {
        toast.success(`账户历史同步已开始 (${syncStartDate} 至 ${syncEndDate})，请稍候...`);
      } else {
        toast.error('同步请求失败');
      }
    } catch (error) {
      toast.error('无法连接到服务器');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleTransfer = async () => {
    if (!transferAccountId || !transferAmount || parseFloat(transferAmount) <= 0) {
      toast.error('请输入有效的划转金额');
      return;
    }

    if (transferPassword !== 'Sunbin7857#') {
      toast.error('划转密码不正确');
      return;
    }

    setIsTransferring(true);
    try {
      const res = await fetchWithAuth('/api/binance/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: transferAccountId,
          asset: 'USDT',
          amount: transferAmount
        })
      });

      if (res.ok) {
        toast.success('划转成功');
        setIsTransferDialogOpen(false);
        setTransferAmount('');
        // Refresh data
        socket?.emit('refresh_data', transferAccountId);
      } else {
        const error = await res.json();
        toast.error(`划转失败: ${error.error || '未知错误'}`);
      }
    } catch (error) {
      toast.error('划转失败，请检查网络连接');
    } finally {
      setIsTransferring(false);
    }
  };

  const fetchSystemStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/system/status');
      if (res.status === 401) {
        setIsLoggedIn(false);
        localStorage.removeItem('gatekeeper_token');
        return;
      }
      const data = await res.json();
      setSystemStatus(data);
    } catch (error) {
      console.error('Failed to fetch system status');
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetchWithAuth('/api/system/logs');
      if (res.ok) {
        const data = await res.json();
        setSystemLogs(data);
      }
    } catch (error) {
      console.error('Failed to fetch logs');
    }
  };

  const fetchAccounts = async () => {
    try {
      const res = await fetchWithAuth('/api/accounts');
      if (res.status === 401) {
        setIsLoggedIn(false);
        localStorage.removeItem('gatekeeper_token');
        return;
      }
      const data = await res.json();
      setAccounts(data);
    } catch (error) {
      toast.error('获取账户列表失败');
    }
  };

  const handleBulkToggle = async (active: boolean) => {
    try {
      const res = await fetchWithAuth('/api/accounts/bulk-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active })
      });
      if (res.ok) {
        toast.success(active ? '正在按顺序开启所有 API...' : '已瞬间关闭所有 API');
        fetchAccounts();
      } else {
        toast.error('操作失败');
      }
    } catch (error) {
      toast.error('网络错误');
    }
  };

  const handleRefreshAllBalances = () => {
    const activeAccounts = accounts.filter(a => a.isActive);
    if (activeAccounts.length === 0) {
      toast.error('没有已开启的 API 账户');
      return;
    }
    
    if (!socket) {
      toast.error('Socket 未连接');
      return;
    }

    toast.info(`正在获取 ${activeAccounts.length} 个账户的余额...`);
    activeAccounts.forEach(acc => {
      socket.emit('refresh_data', acc.id);
    });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoggingIn(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: loginPassword }),
        credentials: 'include'
      });
      if (res.ok) {
        const data = await res.json();
        if (data.token) {
          localStorage.setItem('gatekeeper_token', data.token);
        }
        setIsLoggedIn(true);
        fetchAccounts();
        fetchSystemStatus();
        toast.success('登录成功');
      } else {
        toast.error('密码错误');
      }
    } catch (error) {
      toast.error('登录失败');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchWithAuth('/api/logout', { method: 'POST' });
      setIsLoggedIn(false);
      localStorage.removeItem('gatekeeper_token');
      toast.success('已退出登录');
    } catch (error) {
      toast.error('退出失败');
    }
  };

  const handleBinanceUpdate = (accountId: string, accountName: string, data: any) => {
    if (data.eventType === 'ACCOUNT_UPDATE') {
      const update = data.updateData;
      // Do NOT skip 'ORDER' reason updates, as they contain position changes

      const newBalances = (update.balances || []).map((b: any) => ({
        asset: b.asset,
        balance: b.walletBalance,
        available: b.crossWalletBalance,
        type: 'futures' as const
      }));

      const updatedPositions = (update.positions || [])
        .filter((p: any) => !p.symbol.includes('TRADEFI'))
        .map((p: any) => ({
          accountId,
          accountName,
          symbol: p.symbol,
          amount: p.positionAmount || p.positionAmt || '0',
          entryPrice: p.entryPrice || '0',
          markPrice: p.markPrice || '0',
          pnl: p.unrealizedPnl || p.unRealizedProfit || '0'
        }));

      setBalances(prev => ({ 
        ...prev, 
        [accountId]: [
          ...(prev[accountId] || []).filter(b => b.type !== 'futures'), 
          ...(newBalances || []).map(b => ({
            ...b,
            available: b.available || b.crossWalletBalance || b.balance
          }))
        ] 
      }));
      setPositions(prev => {
        const currentPositions = [...(prev[accountId] || [])];
        updatedPositions.forEach(newP => {
          const index = currentPositions.findIndex(p => p.symbol === newP.symbol);
          if (parseFloat(newP.amount) === 0) {
            if (index !== -1) currentPositions.splice(index, 1);
          } else {
            if (index !== -1) {
              currentPositions[index] = { ...currentPositions[index], ...newP };
            } else {
              currentPositions.push(newP);
            }
          }
        });
        return { ...prev, [accountId]: currentPositions };
      });
    } else if (data.eventType === 'outboundAccountPosition') {
      const newBalances = (data.lastAccountUpdate || []).map((b: any) => ({
        asset: b.asset,
        balance: (parseFloat(b.free) + parseFloat(b.locked)).toString(),
        available: b.free,
        type: 'spot' as const
      }));
      setBalances(prev => ({ ...prev, [accountId]: [...(prev[accountId] || []).filter(b => b.type !== 'spot'), ...newBalances] }));
    } else if (data.eventType === 'ORDER_TRADE_UPDATE') {
      const order = data.order;
      // Ignore orders with zero quantity or TRADEFI symbols
      if (parseFloat(order.originalQuantity || '0') === 0 || order.symbol.includes('TRADEFI')) return;
      
      const isFinalStatus = ['FILLED', 'CANCELED', 'EXPIRED', 'TRIGGERED'].includes(order.orderStatus);
      const orderId = order.orderId.toString();
      
      setOrders(prev => {
        const accountOrders = prev[accountId] || [];
        if (isFinalStatus) {
          // Remove from open orders
          return { ...prev, [accountId]: accountOrders.filter(o => 
            o.orderId?.toString() !== orderId && 
            o.algoId?.toString() !== orderId
          ) };
        } else {
          // Add or update open order
          const newOrder: Order = {
            orderId: orderId,
            accountId,
            accountName,
            symbol: order.symbol,
            side: order.side,
            type: order.orderType,
            price: order.originalPrice,
            stopPrice: order.stopPrice || '0',
            qty: order.originalQuantity,
            status: order.orderStatus,
            time: order.orderTradeTime,
            isAlgo: ['STOP_MARKET', 'TAKE_PROFIT_MARKET', 'STOP', 'TAKE_PROFIT', 'TRAILING_STOP_MARKET', 'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT'].includes(order.orderType) || (order.stopPrice && parseFloat(order.stopPrice) > 0)
          };
          const filtered = accountOrders.filter(o => 
            o.orderId?.toString() !== orderId && 
            o.algoId?.toString() !== orderId
          );
          return { ...prev, [accountId]: [newOrder, ...filtered] };
        }
      });
    } else if (data.eventType === 'ALGO_ORDER_UPDATE') {
      const o = data.algoOrder;
      const algoId = o.algoId.toString();
      const isFinalStatus = ['CANCELED', 'EXPIRED', 'REJECTED', 'FINISHED'].includes(o.algoStatus);
      
      setOrders(prev => {
        const accountOrders = prev[accountId] || [];
        if (isFinalStatus) {
          return { ...prev, [accountId]: accountOrders.filter(ord => 
            ord.orderId?.toString() !== algoId && 
            ord.algoId?.toString() !== algoId
          ) };
        } else {
          const newOrder: Order = {
            orderId: o.orderId?.toString() || algoId,
            algoId: algoId,
            accountId,
            accountName,
            symbol: o.symbol,
            side: o.side,
            type: o.orderType || 'ALGO',
            price: o.price || '0',
            stopPrice: o.triggerPrice || '0',
            qty: o.quantity || '0',
            status: o.algoStatus,
            time: o.updateTime || Date.now(),
            isAlgo: true
          };
          const filtered = accountOrders.filter(ord => 
            ord.orderId?.toString() !== algoId && 
            ord.algoId?.toString() !== algoId
          );
          return { ...prev, [accountId]: [newOrder, ...filtered] };
        }
      });
    } else if (data.eventType === 'markPriceUpdate' || (Array.isArray(data) && data[0]?.eventType === 'markPriceUpdate')) {
      // USER REQUEST: Mark price updates disabled
      return;
    }
  };

  const addAccount = async () => {
    if (!newAccount.name || !newAccount.apiKey || !newAccount.apiSecret) {
      toast.error('请填写完整信息');
      return;
    }

    try {
      const res = await fetchWithAuth('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newAccount)
      });
      if (res.ok) {
        toast.success('账户添加成功');
        setIsAddingAccount(false);
        setNewAccount({ name: '', apiKey: '', apiSecret: '' });
        fetchAccounts();
      }
    } catch (error) {
      toast.error('添加账户失败');
    }
  };

  const deleteAccount = async (id: string) => {
    try {
      await fetchWithAuth(`/api/accounts/${id}`, { method: 'DELETE' });
      toast.success('账户已删除');
      fetchAccounts();
      // Clear its data from UI
      setBalances(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setPositions(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setOrders(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setAccountStatus(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (error) {
      toast.error('删除账户失败');
    }
  };

  const toggleAccount = async (id: string) => {
    try {
      const res = await fetchWithAuth(`/api/accounts/${id}/toggle`, { method: 'POST' });
      if (res.ok) {
        const updated = await res.json();
        toast.success(`${updated.name} 已${updated.isActive ? '开启' : '关闭'} API 接口`);
        fetchAccounts();
        // If deactivated, clear its data from UI
        if (!updated.isActive) {
          setBalances(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setPositions(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setOrders(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setAccountStatus(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        } else {
          // If activated, trigger a refresh
          socket?.emit('refresh_data', id);
        }
      }
    } catch (error) {
      toast.error('切换账户状态失败');
    }
  };

  const queryHistory = async (all = false) => {
    if (!selectedAccountId && !all) return;
    setIsQueryingHistory(true);
    try {
      // Use local date strings to create timestamps correctly
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      const body = {
        accountIds: all ? [] : [selectedAccountId],
        startTime: start.getTime(),
        endTime: end.getTime()
      };
      const res = await fetchWithAuth('/api/binance/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      setHistoryData(data);
      if (data.length === 0) {
        toast.info('所选时间段内未找到成交记录');
      } else {
        toast.success(all ? `查询成功: 找到 ${data.length} 条记录` : '当前账户历史查询成功');
      }
    } catch (error) {
      toast.error('查询历史记录失败');
    } finally {
      setIsQueryingHistory(false);
    }
  };

  const historyTotals = useMemo(() => {
    const symbolPnL: Record<string, number> = {};
    
    const totals = historyData.reduce((acc, h) => {
      const tradePnL = parseFloat(h.realizedPnL || h.realizedPnl || '0');
      const fee = parseFloat(h.commission || '0');
      const funding = parseFloat(h.fundingFee || '0');
      const totalPnL = tradePnL - Math.abs(fee) + funding;
      
      if (h.symbol) {
        symbolPnL[h.symbol] = (symbolPnL[h.symbol] || 0) + totalPnL;
      }
      
      return {
        totalPnL: acc.totalPnL + totalPnL,
        totalFee: acc.totalFee + Math.abs(fee),
        totalFunding: acc.totalFunding + funding,
        totalTradePnL: acc.totalTradePnL + tradePnL
      };
    }, { totalPnL: 0, totalFee: 0, totalFunding: 0, totalTradePnL: 0 });

    let topProfitablePair = { symbol: '-', pnl: 0 };
    let topLosingPair = { symbol: '-', pnl: 0 };

    Object.entries(symbolPnL).forEach(([symbol, pnl]) => {
      if (pnl > topProfitablePair.pnl || topProfitablePair.symbol === '-') {
        if (pnl > 0) topProfitablePair = { symbol, pnl };
      }
      if (pnl < topLosingPair.pnl || topLosingPair.symbol === '-') {
        if (pnl < 0) topLosingPair = { symbol, pnl };
      }
    });

    return { ...totals, topProfitablePair, topLosingPair };
  }, [historyData]);

  const hourlyStats = useMemo(() => {
    const stats = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      label: `${i}-${i + 1}`,
      pnl: 0,
      count: 0,
      winCount: 0
    }));

    historyData.forEach(h => {
      let openTime = new Date(h.openTime);
      if (timeStatsMode === '58') {
        // Shift forward by 2 seconds: 23:59:58 becomes 00:00:00
        openTime = new Date(openTime.getTime() + 2000);
      } else if (timeStatsMode === '02') {
        // Shift backward by 2 seconds: 00:00:02 becomes 00:00:00
        openTime = new Date(openTime.getTime() - 2000);
      }
      const hour = openTime.getHours();
      const tradePnL = parseFloat(h.realizedPnL || h.realizedPnl || '0');
      const fee = parseFloat(h.commission || '0');
      const funding = parseFloat(h.fundingFee || '0');
      const totalPnL = tradePnL - Math.abs(fee) + funding;
      
      stats[hour].pnl += totalPnL;
      stats[hour].count += 1;
      if (totalPnL > 0) {
        stats[hour].winCount += 1;
      }
    });
    return stats;
  }, [historyData, timeStatsMode]);

  const exportToExcel = () => {
    if (historyData.length === 0) return;
    const exportData = (historyData || []).map(h => {
      const tradePnL = parseFloat(h.realizedPnL || h.realizedPnl || '0');
      const fee = parseFloat(h.commission || '0');
      const funding = parseFloat(h.fundingFee || '0');
      const totalPnL = tradePnL - Math.abs(fee) + funding;
      return {
        '账户': h.accountName,
        '开仓时间': format(h.openTime, 'yyyy-MM-dd HH:mm:ss'),
        '平仓时间': format(h.closeTime, 'yyyy-MM-dd HH:mm:ss'),
        '交易对': h.symbol,
        '方向': h.side === 'LONG' ? '多单' : '空单',
        '开仓均价': h.openPrice,
        '平仓均价': h.closePrice,
        '数量': h.qty,
        '成交盈亏': tradePnL,
        '手续费': fee,
        '资金费': funding,
        '总盈亏': totalPnL
      };
    });
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "History");
    XLSX.writeFile(wb, `Binance_History_${format(new Date(), 'yyyyMMdd_HHmm')}.xlsx`);
  };

  const allPositions = useMemo(() => {
    return []; // USER REQUEST: Remove real-time positions
  }, []);

  const allOrders = useMemo(() => {
    return []; // USER REQUEST: Remove real-time orders
  }, []);

  const limitOrders = useMemo(() => allOrders.filter(o => !o.isAlgo), [allOrders]);
  const algoOrders = useMemo(() => allOrders.filter(o => o.isAlgo), [allOrders]);

  const getAccountSummary = (accountId: string) => {
    const accBalances = balances[accountId] || [];
    const spot = accBalances.find(b => b.type === 'spot' && b.asset === 'USDT')?.balance || '0';
    const fut = accBalances.find(b => b.type === 'futures' && b.asset === 'USDT')?.balance || '0';
    const avail = accBalances.find(b => b.type === 'futures' && b.asset === 'USDT')?.available || '0';
    return { spot, fut, avail };
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
        <Toaster position="top-right" />
        <Card className="w-full max-w-md border-neutral-200 shadow-xl">
          <CardHeader className="space-y-1 text-center">
            <div className="w-12 h-12 bg-orange-500 rounded-xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-orange-200">
              <TrendingUp className="text-white w-6 h-6" />
            </div>
            <CardTitle className="text-2xl font-bold tracking-tight">风云监控系统</CardTitle>
            <CardDescription>请输入门卫密码以继续</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <Input 
                  id="password" 
                  type="password" 
                  placeholder="请输入密码" 
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  className="h-11"
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full h-11 bg-orange-500 hover:bg-orange-600 text-white font-bold" disabled={isLoggingIn}>
                {isLoggingIn ? '正在验证...' : '进入系统'}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="text-center text-xs text-neutral-400 border-t pt-4">
            Gatekeeper v1.0
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans">
      <Toaster position="top-right" />
      
      <header className="bg-white border-b border-neutral-200 sticky top-0 z-10">
        <div className="max-w-screen-2xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-orange-500 p-2 rounded-lg">
              <TrendingUp className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">风云监控系统</h1>
          </div>

          <div className="hidden md:flex items-center gap-6 px-6 py-2 bg-neutral-50 rounded-full border border-neutral-100">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-400 uppercase tracking-wider font-bold">API 接口</span>
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${systemStatus.apiStatus === 'Connected' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-xs font-medium">{systemStatus.apiStatus}</span>
              </div>
            </div>
            <div className="w-px h-4 bg-neutral-200" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-400 uppercase tracking-wider font-bold">WS 接口</span>
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${systemStatus.wsStatus === 'Connected' ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-xs font-medium">{systemStatus.wsStatus}</span>
              </div>
            </div>
            <div className="w-px h-4 bg-neutral-200" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-400 uppercase tracking-wider font-bold">服务器出口 IP</span>
              <span className="text-xs font-mono bg-white px-2 py-0.5 rounded border border-neutral-200 text-orange-600 font-bold">
                {systemStatus.serverIp}
              </span>
            </div>
            <div className="w-px h-4 bg-neutral-200" />
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-400 uppercase tracking-wider font-bold">最后同步</span>
              <span className="text-xs font-medium">{format(lastUpdated, 'HH:mm:ss')}</span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <Dialog open={isSyncDialogOpen} onOpenChange={setIsSyncDialogOpen}>
              <DialogTrigger render={
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="h-9 border-neutral-200 text-neutral-600 hover:bg-neutral-50"
                  disabled={isSyncing}
                >
                  <RefreshCw className={`w-4 h-4 mr-1.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  {isSyncing ? '同步中...' : '同步历史'}
                </Button>
              } />
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle>同步历史记录</DialogTitle>
                  <CardDescription>选择需要同步的时间范围，系统将增量抓取数据。</CardDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="syncStart" className="text-right">开始日期</Label>
                    <Input
                      id="syncStart"
                      type="date"
                      value={syncStartDate}
                      onChange={(e) => setSyncStartDate(e.target.value)}
                      className="col-span-3"
                    />
                  </div>
                  <div className="grid grid-cols-4 items-center gap-4">
                    <Label htmlFor="syncEnd" className="text-right">结束日期</Label>
                    <Input
                      id="syncEnd"
                      type="date"
                      value={syncEndDate}
                      onChange={(e) => setSyncEndDate(e.target.value)}
                      className="col-span-3"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsSyncDialogOpen(false)}>取消</Button>
                  <Button onClick={triggerManualSync} className="bg-neutral-900">开始同步</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Dialog open={isTransferDialogOpen} onOpenChange={setIsTransferDialogOpen}>
              <DialogContent className="sm:max-w-[400px]">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <ArrowRightLeft className="w-5 h-5 text-orange-600" />
                    资金划转 (现货 → 合约)
                  </DialogTitle>
                </DialogHeader>
                <div className="py-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="transferAmount" className="text-xs font-bold text-neutral-500 uppercase">划转金额 (USDT)</Label>
                    <Input
                      id="transferAmount"
                      type="number"
                      placeholder="请输入划转金额"
                      value={transferAmount}
                      onChange={(e) => setTransferAmount(e.target.value)}
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="transferPassword" className="text-xs font-bold text-neutral-500 uppercase">划转确认密码</Label>
                    <Input
                      id="transferPassword"
                      type="password"
                      placeholder="请输入码"
                      value={transferPassword}
                      onChange={(e) => setTransferPassword(e.target.value)}
                      className="h-10"
                    />
                    <p className="text-[10px] text-neutral-400">
                      资金将从该账户的 <span className="font-bold">现货账户</span> 划转至 <span className="font-bold">USDT-M 永续合约账户</span>。
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsTransferDialogOpen(false)} disabled={isTransferring}>
                    取消
                  </Button>
                  <Button onClick={handleTransfer} disabled={isTransferring || !transferAmount} className="bg-orange-600 hover:bg-orange-700">
                    {isTransferring ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                    确认划转
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button variant="outline" size="sm" className="h-9 border-neutral-200 text-neutral-600 hover:bg-neutral-50" onClick={handleLogout}>
              退出登录
            </Button>
            <Button 
              variant={selectedAccountId === null ? "default" : "outline"} 
              size="sm" 
              onClick={() => {
                setSelectedAccountId(null);
                accounts.forEach(acc => socket?.emit('refresh_data', acc.id));
                toast.success('正在同步所有账户数据...');
              }}
              className={selectedAccountId === null ? "bg-neutral-900" : ""}
            >
              全局监控
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-screen-2xl mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-6 gap-6">
        {/* Account List */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="border-neutral-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings className="w-4 h-4 text-neutral-500" /> 账户管理
                </div>
                <Dialog open={isAddingAccount} onOpenChange={setIsAddingAccount}>
                  <DialogTrigger render={
                    <Button variant="ghost" size="icon-sm" className="h-6 w-6 text-neutral-400 hover:text-orange-500">
                      <Plus className="w-4 h-4" />
                    </Button>
                  } />
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>添加币安 API 账户</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      <div className="grid gap-2">
                        <Label htmlFor="name">账户名称</Label>
                        <Input id="name" value={newAccount.name} onChange={e => setNewAccount({...newAccount, name: e.target.value})} placeholder="例如: 账户1" />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="apiKey">API Key</Label>
                        <Input id="apiKey" value={newAccount.apiKey} onChange={e => setNewAccount({...newAccount, apiKey: e.target.value})} />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="apiSecret">API Secret</Label>
                        <Input id="apiSecret" type="password" value={newAccount.apiSecret} onChange={e => setNewAccount({...newAccount, apiSecret: e.target.value})} />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddingAccount(false)}>取消</Button>
                      <Button onClick={addAccount} className="bg-orange-500 hover:bg-orange-600">保存</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </CardTitle>
              <div className="px-0 pt-2 pb-0">
                <div className="flex gap-1.5">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="flex-1 h-8 text-[10px] border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 font-bold"
                    onClick={() => handleBulkToggle(false)}
                  >
                    关闭
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="flex-1 h-8 text-[10px] border-green-200 text-green-600 hover:bg-green-50 hover:text-green-700 font-bold"
                    onClick={() => handleBulkToggle(true)}
                  >
                    开启
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="flex-1 h-8 text-[10px] border-blue-200 text-blue-600 hover:bg-blue-50 hover:text-blue-700 font-bold"
                    onClick={handleRefreshAllBalances}
                  >
                    余额
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100vh-200px)]">
                {accounts.length === 0 ? (
                  <div className="p-8 text-center text-neutral-500">
                    <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">暂无账户</p>
                  </div>
                ) : (
                  <div className="divide-y divide-neutral-100">
                    {(accounts || []).map(account => {
                      const summary = getAccountSummary(account.id);
                      return (
                        <div 
                          key={account.id}
                          onClick={() => setSelectedAccountId(account.id)}
                          className={`p-4 cursor-pointer transition-all flex flex-col gap-2 group ${
                            selectedAccountId === account.id 
                              ? 'bg-orange-50 border-l-4 border-orange-500' 
                              : account.isActive ? 'hover:bg-neutral-50' : 'bg-neutral-50/50 opacity-80'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div 
                                className={`w-2 h-2 rounded-full ${
                                  accountStatus[account.id] === 'connected' ? 'bg-green-500 animate-pulse' : 
                                  accountStatus[account.id] === 'reconnecting' ? 'bg-orange-500 animate-bounce' :
                                  accountStatus[account.id] === 'error' ? 'bg-red-500' :
                                  'bg-neutral-300'
                                }`} 
                              />
                              <span className={`font-bold text-sm ${!account.isActive ? 'text-neutral-400' : ''}`}>{account.name}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className={`h-7 w-7 rounded-full ${
                                  account.isActive ? 'text-green-500' : 'text-neutral-300'
                                }`}
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  toggleAccount(account.id);
                                }}
                              >
                                {account.isActive ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                              </Button>
                              <Button 
                                variant="ghost" 
                                size="icon" 
                                className="h-7 w-7 rounded-full text-neutral-300 hover:text-red-500 hover:bg-neutral-100"
                                onClick={(e) => { 
                                  e.stopPropagation(); 
                                  deleteAccount(account.id);
                                }}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        {/* Main Content */}
        <div className="lg:col-span-5 space-y-6">
          <Tabs defaultValue="realtime" className="w-full">
            <TabsList className="grid w-full grid-cols-3 mb-6">
              <TabsTrigger value="realtime">实时监控</TabsTrigger>
              <TabsTrigger value="history">历史查询</TabsTrigger>
              <TabsTrigger value="logs">系统日志</TabsTrigger>
            </TabsList>

            <TabsContent value="realtime" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-5 gap-4">
                {accounts.length === 0 ? (
                  <Card className="col-span-full p-12 text-center border-dashed border-2 border-neutral-200 bg-neutral-50/50">
                    <div className="flex flex-col items-center gap-4">
                      <AlertCircle className="w-12 h-12 text-neutral-300" />
                      <div className="space-y-1">
                        <p className="text-lg font-bold text-neutral-900">暂无账户数据</p>
                        <p className="text-sm text-neutral-500">请在左侧侧边栏添加您的币安 API 账户</p>
                      </div>
                      <Button onClick={() => setIsAddingAccount(true)} className="bg-orange-500 hover:bg-orange-600">
                        添加首个账户
                      </Button>
                    </div>
                  </Card>
                ) : (
                  accounts.map(account => {
                    const summary = getAccountSummary(account.id);
                    const status = accountStatus[account.id] || 'disconnected';
                    
                    return (
                      <Card key={account.id} className={`overflow-hidden border-2 transition-all ${
                        selectedAccountId === account.id ? 'border-orange-500 shadow-md ring-1 ring-orange-500/20' : 'border-neutral-200 hover:border-neutral-300'
                      }`}>
                        <div className={`h-1.5 w-full ${
                          status === 'connected' ? 'bg-green-500' : 
                          status === 'reconnecting' ? 'bg-orange-500' : 
                          'bg-neutral-300'
                        }`} />
                        <CardHeader className="pb-2 pt-3 px-4">
                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <CardTitle className="text-lg font-bold tracking-tight flex items-center gap-1.5">
                                {account.name}
                                {status === 'connected' && <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                              </CardTitle>
                              <div className="flex items-center gap-1.5">
                                <Badge variant="outline" className={`text-[9px] px-1 h-4 font-bold uppercase tracking-wider ${
                                  account.isActive ? 'bg-green-50 text-green-700 border-green-200' : 'bg-neutral-100 text-neutral-500 border-neutral-200'
                                }`}>
                                  {account.isActive ? 'Active' : 'Disabled'}
                                </Badge>
                                <span className="text-[9px] font-medium text-neutral-400 uppercase tracking-tight">
                                  {status === 'connected' ? 'WS ON' : 'WS OFF'}
                                </span>
                              </div>
                            </div>
                            <div className="flex gap-1">
                              <Button 
                                variant="outline" 
                                size="icon" 
                                className="h-7 w-7 rounded-md border-neutral-200 hover:bg-orange-50 hover:text-orange-600"
                                onClick={() => {
                                  socket?.emit('refresh_data', account.id);
                                  toast.info(`正在刷新 ${account.name} 数据...`);
                                }}
                                disabled={!account.isActive}
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </Button>
                              <Button 
                                variant="outline" 
                                size="icon" 
                                className="h-7 w-7 rounded-md border-neutral-200 hover:bg-red-50 hover:text-red-600"
                                onClick={() => deleteAccount(account.id)}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-3 pb-4 px-4">
                          <div className="grid grid-cols-1 gap-2.5">
                            <div className="p-2.5 rounded-lg bg-neutral-50 border border-neutral-100 group hover:bg-white hover:shadow-sm transition-all relative">
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-widest mb-0.5">现货 USDT 余额</p>
                              <div className="flex items-baseline gap-1.5">
                                <span className="text-xl font-black tracking-tighter text-neutral-900">
                                  {parseFloat(summary.spot).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                                <span className="text-[10px] font-bold text-neutral-400">USDT</span>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-orange-50 hover:text-orange-600"
                                onClick={() => {
                                  setTransferAccountId(account.id);
                                  setTransferAmount('');
                                  setTransferPassword('');
                                  setIsTransferDialogOpen(true);
                                }}
                                disabled={!account.isActive}
                                title="资金划转 (现货 -> 合约)"
                              >
                                <ArrowRightLeft className="w-4 h-4" />
                              </Button>
                            </div>
                            
                            <div className="p-2.5 rounded-lg bg-neutral-50 border border-neutral-100 group hover:bg-white hover:shadow-sm transition-all">
                              <p className="text-[9px] font-bold text-neutral-400 uppercase tracking-widest mb-0.5">合约 钱包余额</p>
                              <div className="flex items-baseline gap-1.5">
                                <span className="text-xl font-black tracking-tighter text-neutral-900">
                                  {parseFloat(summary.fut).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                                <span className="text-[10px] font-bold text-neutral-400">USDT</span>
                              </div>
                            </div>
 
                            <div className="p-3 rounded-lg bg-orange-50 border border-orange-100 group hover:bg-orange-100/30 transition-all">
                              <div className="flex items-center justify-between mb-0.5">
                                <p className="text-[9px] font-black text-orange-600 uppercase tracking-widest">合约 可用保证金</p>
                                <TrendingUp className="w-3 h-3 text-orange-500" />
                              </div>
                              <div className="flex items-baseline gap-1.5">
                                <span className="text-2xl font-black tracking-tighter text-orange-600">
                                  {parseFloat(summary.avail).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                                <span className="text-[10px] font-black text-orange-400">USDT</span>
                              </div>
                            </div>
                          </div>
                          
                          <Button 
                            variant={account.isActive ? "destructive" : "default"} 
                            className={`w-full h-9 font-bold text-xs rounded-lg shadow-sm ${
                              !account.isActive ? 'bg-green-600 hover:bg-green-700' : ''
                            }`}
                            onClick={() => toggleAccount(account.id)}
                          >
                            {account.isActive ? (
                              <><PowerOff className="w-3.5 h-3.5 mr-1.5" /> 关闭 API</>
                            ) : (
                              <><Power className="w-3.5 h-3.5 mr-1.5" /> 开启 API</>
                            )}
                          </Button>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
            </TabsContent>

            <TabsContent value="history" className="space-y-4">
              <div className="flex flex-col space-y-4">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between bg-white p-4 rounded-xl border border-neutral-200 shadow-sm gap-4">
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2 bg-neutral-50 p-1 px-2 rounded-md border border-neutral-100">
                      <Label htmlFor="startDate" className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">开始</Label>
                      <Input 
                        id="startDate"
                        type="date" 
                        value={startDate} 
                        onChange={(e) => setStartDate(e.target.value)}
                        className="h-7 w-32 text-xs border-none bg-transparent focus-visible:ring-0 p-0"
                      />
                    </div>
                    <div className="flex items-center gap-2 bg-neutral-50 p-1 px-2 rounded-md border border-neutral-100">
                      <Label htmlFor="endDate" className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">结束</Label>
                      <Input 
                        id="endDate"
                        type="date" 
                        value={endDate} 
                        onChange={(e) => setEndDate(e.target.value)}
                        className="h-7 w-32 text-xs border-none bg-transparent focus-visible:ring-0 p-0"
                      />
                    </div>
                    <div className="h-6 w-[1px] bg-neutral-200 mx-1 hidden lg:block" />
                    <div className="flex items-center gap-2">
                      <Button onClick={() => queryHistory(false)} disabled={isQueryingHistory || !selectedAccountId} className="bg-neutral-900 h-9 px-4 text-xs font-medium">
                        {isQueryingHistory ? <RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-2" />}
                        查询当前账户
                      </Button>
                      <Button onClick={() => queryHistory(true)} disabled={isQueryingHistory} variant="secondary" className="h-9 px-4 text-xs font-medium">
                        查询所有账户
                      </Button>
                      <Button variant="outline" onClick={exportToExcel} disabled={historyData.length === 0} className="h-9 px-4 text-xs font-medium border-neutral-200 hover:bg-neutral-50">
                        <Download className="w-3.5 h-3.5 mr-2" /> 导出 Excel
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-medium text-neutral-500 bg-neutral-50 px-3 py-1.5 rounded-full border border-neutral-100">
                    <div className="flex items-center gap-1.5 mr-2 pr-2 border-r border-neutral-200">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      <span className="text-[10px] text-blue-600 font-bold uppercase tracking-tight">本地数据库</span>
                    </div>
                    <FileText className="w-3.5 h-3.5 text-neutral-400" />
                    共找到 <span className="text-neutral-900 font-bold">{historyData.length}</span> 条记录
                  </div>
                </div>

                {historyData.length > 0 && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                    <Card className="border-neutral-200 shadow-sm overflow-hidden group hover:border-neutral-300 transition-colors">
                      <div className="h-1 bg-neutral-900" />
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">累计总盈亏</p>
                          <TrendingUp className={`w-3.5 h-3.5 ${historyTotals.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}`} />
                        </div>
                        <div className="flex items-baseline gap-1">
                          <p className={`text-2xl font-bold tracking-tight ${historyTotals.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {historyTotals.totalPnL >= 0 ? '+' : ''}{historyTotals.totalPnL.toFixed(2)}
                          </p>
                          <span className="text-[10px] font-medium text-neutral-400">USDT</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-neutral-200 shadow-sm overflow-hidden group hover:border-neutral-300 transition-colors">
                      <div className="h-1 bg-blue-500" />
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">累计成交盈亏</p>
                          <TrendingUp className={`w-3.5 h-3.5 ${historyTotals.totalTradePnL >= 0 ? 'text-green-500' : 'text-red-500'}`} />
                        </div>
                        <div className="flex items-baseline gap-1">
                          <p className={`text-2xl font-bold tracking-tight ${historyTotals.totalTradePnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {historyTotals.totalTradePnL >= 0 ? '+' : ''}{historyTotals.totalTradePnL.toFixed(2)}
                          </p>
                          <span className="text-[10px] font-medium text-neutral-400">USDT</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-neutral-200 shadow-sm overflow-hidden group hover:border-neutral-300 transition-colors">
                      <div className="h-1 bg-red-500" />
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">累计手续费</p>
                          <Wallet className="w-3.5 h-3.5 text-red-400" />
                        </div>
                        <div className="flex items-baseline gap-1">
                          <p className="text-2xl font-bold tracking-tight text-red-500">
                            -{historyTotals.totalFee.toFixed(2)}
                          </p>
                          <span className="text-[10px] font-medium text-neutral-400">USDT</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-neutral-200 shadow-sm overflow-hidden group hover:border-neutral-300 transition-colors">
                      <div className="h-1 bg-orange-500" />
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">累计资金费</p>
                          <RefreshCw className={`w-3.5 h-3.5 ${historyTotals.totalFunding >= 0 ? 'text-green-500' : 'text-red-500'}`} />
                        </div>
                        <div className="flex items-baseline gap-1">
                          <p className={`text-2xl font-bold tracking-tight ${historyTotals.totalFunding >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {historyTotals.totalFunding >= 0 ? '+' : ''}{historyTotals.totalFunding.toFixed(2)}
                          </p>
                          <span className="text-[10px] font-medium text-neutral-400">USDT</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-neutral-200 shadow-sm overflow-hidden group hover:border-neutral-300 transition-colors">
                      <div className="h-1 bg-green-500" />
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">盈利最高币对</p>
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-green-50 text-green-600 border-green-100">
                            {historyTotals.topProfitablePair.symbol}
                          </Badge>
                        </div>
                        <div className="flex items-baseline gap-1">
                          <p className="text-2xl font-bold tracking-tight text-green-600">
                            +{historyTotals.topProfitablePair.pnl.toFixed(2)}
                          </p>
                          <span className="text-[10px] font-medium text-neutral-400">USDT</span>
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="border-neutral-200 shadow-sm overflow-hidden group hover:border-neutral-300 transition-colors">
                      <div className="h-1 bg-rose-500" />
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-wider">亏损最高币对</p>
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-rose-50 text-rose-600 border-rose-100">
                            {historyTotals.topLosingPair.symbol}
                          </Badge>
                        </div>
                        <div className="flex items-baseline gap-1">
                          <p className="text-2xl font-bold tracking-tight text-rose-600">
                            {historyTotals.topLosingPair.pnl.toFixed(2)}
                          </p>
                          <span className="text-[10px] font-medium text-neutral-400">USDT</span>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}
              </div>

                {historyData.length > 0 && (
                  <Card className="border-neutral-200 shadow-sm mb-6">
                    <CardHeader className="pb-3 border-b border-neutral-100 bg-neutral-50/50 flex flex-row items-center justify-between space-y-0">
                      <CardTitle className="text-sm font-bold flex items-center gap-2">
                        <Clock className="w-4 h-4 text-blue-500" />
                        分时段交易统计 (24小时分布)
                      </CardTitle>
                      <div className="flex items-center gap-1 bg-neutral-100 p-0.5 rounded-lg border border-neutral-200">
                        <button 
                          onClick={() => setTimeStatsMode('02')}
                          className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${timeStatsMode === '02' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-400 hover:text-neutral-600'}`}
                        >
                          02开始
                        </button>
                        <button 
                          onClick={() => setTimeStatsMode('58')}
                          className={`px-3 py-1 text-[10px] font-bold rounded-md transition-all ${timeStatsMode === '58' ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-400 hover:text-neutral-600'}`}
                        >
                          58开始
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent className="p-0">
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 divide-x divide-y divide-neutral-100">
                        {(hourlyStats || []).map((stat) => {
                          const winRate = stat.count > 0 ? (stat.winCount / stat.count) * 100 : 0;
                          return (
                            <div key={stat.hour} className="p-3 hover:bg-neutral-50 transition-colors">
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold text-neutral-400 uppercase">{stat.label} 时段</span>
                                <Badge variant="outline" className="text-[9px] h-4 px-1 border-neutral-200 text-neutral-500 font-mono">
                                  {stat.count}单
                                </Badge>
                              </div>
                              <div className="space-y-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-neutral-400">盈亏总计</span>
                                  <span className={`text-xs font-bold font-mono ${stat.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {stat.pnl >= 0 ? '+' : ''}{stat.pnl.toFixed(2)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] text-neutral-400">胜率</span>
                                  <span className={`text-xs font-bold font-mono ${winRate >= 50 ? 'text-blue-600' : 'text-neutral-600'}`}>
                                    {winRate.toFixed(0)}%
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card className="border-neutral-200 shadow-sm">
                  <CardContent className="p-0">
                    <ScrollArea className="h-[600px]">
                      <Table className="relative">
                        <TableHeader className="sticky top-0 bg-white z-20 shadow-sm">
                          <TableRow>
                            <TableHead className="pl-4 sticky top-0 bg-white z-20">账户</TableHead>
                            <TableHead className="sticky top-0 bg-white z-20">开仓时间</TableHead>
                            <TableHead className="sticky top-0 bg-white z-20">平仓时间</TableHead>
                            <TableHead className="sticky top-0 bg-white z-20">交易对</TableHead>
                            <TableHead className="text-right sticky top-0 bg-white z-20">开仓均价</TableHead>
                            <TableHead className="text-right sticky top-0 bg-white z-20">平仓均价</TableHead>
                            <TableHead className="text-right sticky top-0 bg-white z-20">成交盈亏</TableHead>
                            <TableHead className="text-right sticky top-0 bg-white z-20">手续费</TableHead>
                            <TableHead className="text-right sticky top-0 bg-white z-20">资金费</TableHead>
                            <TableHead className="text-right pr-4 sticky top-0 bg-white z-20">总盈亏</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {historyData.length === 0 ? (
                            <TableRow><TableCell colSpan={10} className="text-center py-20 text-neutral-400">点击“查询”获取数据</TableCell></TableRow>
                          ) : (
                            (historyData || []).map((h, i) => {
                              const tradePnL = parseFloat(h.realizedPnL || h.realizedPnl || '0');
                              const fee = parseFloat(h.commission || '0');
                              const funding = parseFloat(h.fundingFee || '0');
                              const totalPnL = tradePnL - Math.abs(fee) + funding;

                              return (
                                <TableRow key={i} className="hover:bg-neutral-50/50">
                                  <TableCell className="pl-4 text-xs text-neutral-500">{h.accountName}</TableCell>
                                  <TableCell className="text-[10px] text-neutral-400">{format(h.openTime, 'MM-dd HH:mm')}</TableCell>
                                  <TableCell className="text-[10px] text-neutral-400">
                                    {h.isOpen ? (
                                      <span className="text-blue-500 font-medium">进行中</span>
                                    ) : (
                                      format(h.closeTime, 'MM-dd HH:mm')
                                    )}
                                  </TableCell>
                                  <TableCell className="font-bold text-sm">
                                    <div className="flex items-center gap-2">
                                      {h.symbol}
                                      <Badge variant={h.side === 'LONG' ? 'default' : 'destructive'} className={`text-[9px] h-4 px-1 ${h.side === 'LONG' ? 'bg-green-500' : 'bg-red-500'}`}>
                                        {h.side === 'LONG' ? '多单' : '空单'}
                                      </Badge>
                                      {h.isOpen && (
                                        <Badge variant="outline" className="text-[9px] h-4 px-1 border-blue-500 text-blue-500">
                                          持仓中
                                        </Badge>
                                      )}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-[10px]">{h.openPrice.toFixed(6)}</TableCell>
                                  <TableCell className="text-right font-mono text-[10px]">{h.closePrice.toFixed(6)}</TableCell>
                                  <TableCell className={`text-right font-mono text-xs ${tradePnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {tradePnL.toFixed(4)}
                                  </TableCell>
                                  <TableCell className="text-right font-mono text-xs text-red-500">
                                    {fee.toFixed(4)}
                                  </TableCell>
                                  <TableCell className={`text-right font-mono text-xs ${funding >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {funding.toFixed(4)}
                                  </TableCell>
                                  <TableCell className={`text-right font-bold pr-4 ${totalPnL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {totalPnL.toFixed(4)}
                                  </TableCell>
                                </TableRow>
                              );
                            })
                          )}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </CardContent>
                </Card>
            </TabsContent>
            <TabsContent value="logs" className="mt-6">
              <Card className="border-neutral-200 shadow-sm">
                <CardHeader className="pb-3 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">系统日志</CardTitle>
                    <CardDescription>记录 API 接口状态、重连及系统事件</CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={fetchLogs}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> 刷新日志
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <ScrollArea className="h-[600px]">
                    <Table>
                      <TableHeader className="sticky top-0 bg-white z-10">
                        <TableRow>
                          <TableHead className="pl-4 w-[180px]">时间</TableHead>
                          <TableHead className="w-[100px]">级别</TableHead>
                          <TableHead className="w-[150px]">账户 ID</TableHead>
                          <TableHead className="pr-4">消息内容</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {systemLogs.length === 0 ? (
                          <TableRow><TableCell colSpan={4} className="text-center py-20 text-neutral-400">暂无日志记录</TableCell></TableRow>
                        ) : (
                          (systemLogs || []).map((log, i) => (
                            <TableRow key={i} className="hover:bg-neutral-50/50">
                              <TableCell className="pl-4 text-[10px] text-neutral-400 font-mono">
                                {format(log.timestamp, 'yyyy-MM-dd HH:mm:ss')}
                              </TableCell>
                              <TableCell>
                                <Badge 
                                  variant="outline" 
                                  className={`text-[9px] h-4 px-1.5 font-bold uppercase ${
                                    log.level === 'error' ? 'bg-red-50 text-red-600 border-red-100' :
                                    log.level === 'warn' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                                    'bg-blue-50 text-blue-600 border-blue-100'
                                  }`}
                                >
                                  {log.level}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-[10px] text-neutral-500 font-mono">
                                {log.accountId || 'SYSTEM'}
                              </TableCell>
                              <TableCell className="pr-4 text-xs font-medium text-neutral-700">
                                {log.message}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
