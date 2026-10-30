import React from 'react';

interface BrandLogoProps {
  href?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  showSubtitle?: boolean;
}

export const BrandLogo: React.FC<BrandLogoProps> = ({
  href = '/',
  onClick,
  className = '',
  size = 'md',
  showSubtitle = true,
}) => {
  const iconSizes = {
    sm: 'w-7 h-7',
    md: 'w-9 h-9',
    lg: 'w-11 h-11',
  };

  const arabicTextSizes = {
    sm: 'text-xl',
    md: 'text-2xl',
    lg: 'text-3xl',
  };

  const subtitleSizes = {
    sm: 'text-[9px]',
    md: 'text-[10px]',
    lg: 'text-[11px]',
  };

  return (
    <a
      href={href}
      onClick={onClick}
      aria-label="الأطلس — الصفحة الرئيسية"
      title="الأطلس — الانتقال إلى الصفحة الرئيسية"
      className={`group inline-flex items-center gap-2.5 select-none transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#0284C7] rounded-xl px-1.5 py-1 -mx-1.5 -my-1 cursor-pointer ${className}`}
    >
      {/* Visual Insignia: Geometric Medical Atlas Emblem */}
      <div
        className={`${iconSizes[size]} relative shrink-0 rounded-xl bg-gradient-to-br from-[#0284C7] via-[#0369A1] to-[#075985] p-0.5 shadow-sm shadow-[#0284C7]/20 group-hover:shadow-md group-hover:shadow-[#0284C7]/30 group-hover:scale-105 transition-all duration-200 flex items-center justify-center`}
      >
        <svg
          viewBox="0 0 36 36"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="w-full h-full text-white"
        >
          {/* Subtle outer sphere ring */}
          <circle
            cx="18"
            cy="18"
            r="14.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeOpacity="0.3"
          />
          {/* Latitude ellipse */}
          <ellipse
            cx="18"
            cy="18"
            rx="14"
            ry="6"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeOpacity="0.4"
          />
          {/* Central Medical Cross + Knowledge Spine */}
          <path
            d="M18 7V29M7 18H29"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* Academic Leaf / Diamond Accent */}
          <circle cx="18" cy="18" r="3" fill="#38BDF8" />
        </svg>
      </div>

      {/* Typography: Beautiful Arabic Calligraphic Wordmark "الأطلس" */}
      <div className="flex flex-col text-left justify-center">
        <span
          dir="rtl"
          style={{ fontFamily: "'Amiri', 'Traditional Arabic', 'Cairo', serif" }}
          className={`${arabicTextSizes[size]} font-bold text-slate-900 group-hover:text-[#0284C7] transition-colors duration-200 leading-none tracking-wide`}
        >
          الأطلس
        </span>
        {showSubtitle && (
          <span
            className={`${subtitleSizes[size]} font-sans font-semibold tracking-wider uppercase text-slate-400 group-hover:text-slate-600 transition-colors duration-200 mt-0.5`}
          >
            MedAtlas MCQ
          </span>
        )}
      </div>
    </a>
  );
};
