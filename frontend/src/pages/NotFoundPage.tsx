import { Compass } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '../components/ui';

export function NotFoundPage() {
  const navigate = useNavigate();
  return <div className="page"><EmptyState icon={<Compass size={25} />} title="页面不存在" action={<Button variant="primary" onClick={() => navigate('/')}>返回首页</Button>} /></div>;
}
